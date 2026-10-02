// Docrot: finds documentation that mentions functions, files, flags or settings that no longer exist in the code.
import { useMemo, useRef, useState } from "react";
import { download, useStored } from "./lib/store";
import { Section, Stat, Stats } from "./ui/kit";

const T = "docrot";
type File = { path: string; text: string };
type Ref = { doc: string; line: number; ref: string; kind: string; context: string };
const SAMPLE: File[] = [
  { path: "README.md", text: "# Invoicer\n\nRun `npm run dev` to start.\n\nSet `DATABASE_URL` and `SMTP_HOST` in your `.env`.\n\nUse `createInvoice(customer, lines)` to make an invoice, then `sendInvoice(id)`.\n\nThe PDF template lives in `src/templates/invoice.hbs`.\n\nPass `--dry-run` to the CLI to preview emails." },
  { path: "docs/api.md", text: "## Invoices\n\n`GET /api/invoices` lists invoices.\n\nCall `markPaid(invoiceId, date)` when money arrives.\n\nSee `src/billing/tax.ts` for VAT rules. `calculateVat()` rounds to 3 decimals for TND." },
  { path: "src/invoices.ts", text: "export async function createInvoice(customer: Customer, lines: Line[]) {}\nexport async function sendInvoiceEmail(id: string) {}\nexport function markAsPaid(invoiceId: string, at: Date) {}" },
  { path: "src/billing/vat.ts", text: "export function calculateVat(amount: number) { return Math.round(amount * 0.19 * 1000) / 1000; }" },
  { path: "src/templates/invoice.hbs", text: "<h1>{{number}}</h1>" },
  { path: "src/cli.ts", text: "program.option('--preview', 'show emails without sending');\nconst db = process.env.DATABASE_URL; const host = process.env.MAIL_HOST;" },
  { path: "package.json", text: '{ "scripts": { "dev": "vite", "build": "vite build" } }' },
  { path: "src/routes.ts", text: "app.get('/api/invoices', listInvoices);" },
];
const isDoc = (p: string) => /\.(md|mdx|rst|txt|adoc)$/i.test(p);
const IGNORE = new Set(["npm", "run", "yarn", "pnpm", "node", "git", "cd", "true", "false", "null", "undefined", "env"]);

/** Pull checkable references out of inline code in docs. */
function refsIn(doc: File): Ref[] {
  const out: Ref[] = [];
  doc.text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      const code = m[1].trim();
      const push = (ref: string, kind: string) => { if (!IGNORE.has(ref.toLowerCase())) out.push({ doc: doc.path, line: i + 1, ref, kind, context: line.trim().slice(0, 140) }); };
      if (/^[\w./-]+\.\w{1,5}$/.test(code) && code.includes("/")) push(code, "file");
      else if (/^--?[\w-]+$/.test(code)) push(code, "flag");
      else if (/^[A-Z][A-Z0-9_]{3,}$/.test(code)) push(code, "setting");
      else if (/^(GET|POST|PUT|PATCH|DELETE)\s+\//.test(code)) push(code.split(/\s+/)[1], "route");
      else { const fn = code.match(/^([A-Za-z_$][\w$]*)(?:\.[\w$]+)*\s*\(/); if (fn) push(code.match(/([A-Za-z_$][\w$]*)\s*\(/)![1], "function"); else if (/^npm run [\w:-]+$/.test(code)) push(code.split(" ")[2], "script"); }
    }
  });
  return out;
}

export default function Docrot() {
  const [files, setFiles] = useStored<File[]>(T, "files", SAMPLE);
  const [kind, setKind] = useState("");
  const pick = useRef<HTMLInputElement>(null);
  const { docs, code, refs, rotten } = useMemo(() => {
    const docs = files.filter(f => isDoc(f.path)), code = files.filter(f => !isDoc(f.path));
    const paths = new Set(code.map(f => f.path.replace(/^\.?\//, "")));
    const blob = code.map(f => f.text).join("\n");
    const refs = docs.flatMap(refsIn);
    const exists = (r: Ref) => r.kind === "file" ? paths.has(r.ref.replace(/^\.?\//, "")) || [...paths].some(p => p.endsWith(r.ref))
      : r.kind === "script" ? new RegExp(`"${r.ref}"\\s*:`).test(blob)
        : r.kind === "route" ? blob.includes(r.ref)
          : new RegExp(`(^|[^\\w$-])${r.ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\w$-]|$)`).test(blob);
    return { docs, code, refs, rotten: refs.filter(r => !exists(r)) };
  }, [files]);
  // Suggest the closest real name: helps spot renames like sendInvoice -> sendInvoiceEmail.
  const idents = useMemo(() => [...new Set(code.flatMap(f => f.text.match(/[A-Za-z_$][\w$]{3,}|--[\w-]+|[A-Z][A-Z0-9_]{3,}/g) ?? []))], [code]);
  // Compare names of the same style (CONSTANT, --flag, camelCase) by the words they share.
  const shape = (s: string) => (s.startsWith("--") ? "flag" : /^[A-Z0-9_]+$/.test(s) ? "const" : "ident");
  const words = (s: string) => s.replace(/^-+/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[\s_-]+/).filter(Boolean);
  const near = (r: Ref) => {
    const w = words(r.ref), sh = shape(r.ref);
    return idents.filter(i => shape(i) === sh && i !== r.ref).map(i => ({ i, s: words(i).filter(x => w.includes(x)).length, d: Math.abs(i.length - r.ref.length) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s || a.d - b.d).slice(0, 2).map(x => x.i);
  };
  const load = async (list: FileList | null) => {
    if (!list) return;
    const keep = [...list].filter(f => f.size < 400_000 && !/node_modules|\.git\/|dist\/|build\//.test(f.webkitRelativePath || f.name) && /\.(md|mdx|rst|txt|ts|tsx|js|jsx|py|go|rb|java|kt|cs|php|rs|json|ya?ml|toml|sh|hbs|html|vue|svelte)$/i.test(f.name));
    setFiles(await Promise.all(keep.map(async f => ({ path: (f.webkitRelativePath || f.name).split("/").slice(1).join("/") || f.name, text: await f.text() }))));
  };
  const shown = rotten.filter(r => !kind || r.kind === kind);
  const report = `# Stale documentation\n\n${rotten.map(r => `- [ ] ${r.doc}:${r.line} mentions \`${r.ref}\` (${r.kind}) which is not in the code${near(r).length ? `. Did you mean \`${near(r)[0]}\`?` : ""}`).join("\n")}`;

  return (
    <div className="stack">
      <Section title="Documentation health" aside={<><button className="btn small primary" onClick={() => pick.current?.click()}>Choose a project folder</button><input ref={pick} type="file" hidden multiple {...{ webkitdirectory: "" }} onChange={e => load(e.target.files)} /><button className="btn small" disabled={!rotten.length} onClick={() => download("stale-docs.md", report, "text/markdown")}>Export checklist</button></>}>
        <Stats><Stat value={docs.length} label="Docs" /><Stat value={code.length} label="Code files" /><Stat value={refs.length} label="References checked" /><Stat value={rotten.length} label="Point at nothing" tone={rotten.length ? "bad" : "good"} /><Stat value={refs.length ? `${Math.round((1 - rotten.length / refs.length) * 100)}%` : "–"} label="Still accurate" /></Stats>
        <p className="note" style={{ marginTop: 10 }}>Files are read in your browser only. node_modules, build folders and large files are skipped.</p>
      </Section>
      <Section title="Stale references" aside={<div className="seg-mini">{["", "function", "file", "setting", "flag", "route", "script"].map(k => <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>{k || "All"}</button>)}</div>}>
        {shown.length === 0 ? <p className="empty-note">Everything the docs mention exists in the code.</p> : shown.map((r, i) => (
          <div key={i} className="dr-row">
            <div style={{ flex: 1, minWidth: 0 }}><p><code className="dr-ref">{r.ref}</code> <span className="pill">{r.kind}</span> <span className="note">{r.doc}, line {r.line}</span></p><p className="note dr-ctx">{r.context}</p></div>
            {near(r).length > 0 && <span className="note">Did you mean {near(r).map((n, k) => <span key={n}>{k > 0 && " or "}<code>{n}</code></span>)}?</span>}
          </div>))}
      </Section>
      <Section title="Files loaded"><div className="dr-files">{files.map(f => <span key={f.path} className={isDoc(f.path) ? "doc" : ""}>{f.path}</span>)}</div></Section>
      <style>{`.dr-row{display:flex;gap:12px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line);flex-wrap:wrap}.dr-ref,.dr-row code{font-family:var(--mono);font-size:13px;background:var(--sunk);padding:1px 6px;border-radius:4px}.dr-ctx{font-family:var(--mono);font-size:12px;margin-top:4px}
      .dr-files{display:flex;flex-wrap:wrap;gap:6px}.dr-files span{font-family:var(--mono);font-size:12px;border:1px solid var(--line);border-radius:4px;padding:2px 6px}.dr-files .doc{border-color:var(--accent);color:var(--accent)}`}</style>
    </div>
  );
}
