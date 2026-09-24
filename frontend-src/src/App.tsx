"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { AuditAlert, AlertStatus, Publication, Severity } from "./audit";
import { DEFAULT_INTEREST_TERMS, brl, parseInterestTerms, sanitizeInterestTerms, severityFrom } from "./audit";
import { formatUasg, formatUasgEvidence } from "./uasg";

type View = "dashboard" | "files" | "trails" | "alerts" | "publications" | "settings";
type IconName = "grid" | "database" | "route" | "bell" | "file" | "chart" | "settings" | "search" | "download" | "upload" | "chevron" | "shield" | "clock" | "check" | "close" | "external" | "info" | "trash" | "history" | "user" | "refresh";
type Batch = { id: string; fileName: string; fileSize: number; checksum: string; rowCount: number; alertCount: number; status: string; importedBy: string; isActive: boolean; createdAt: string };
type StoredAlert = AuditAlert & { importId: string; notes: string; assignedTo: string; dueDate: string; reviewedAt: string; updatedAt: string };
type StoredPublication = Publication & { importId: string };
type Trail = { id: string; name: string; category: string; description: string; active: boolean; updatedAt: string };
type AuditEvent = { id: string; alertId: string; action: string; fromStatus: string; toStatus: string; note: string; actor: string; createdAt: string };
type AppState = { batches: Batch[]; activeBatches: Batch[]; activeBatch: Batch | null; publications: StoredPublication[]; alerts: StoredAlert[]; trails: Trail[]; settings: Record<string, string>; events: AuditEvent[] };
type SettingsDraft = { materiality: string; publicationLag: string; retentionDays: string; interestTerms: string[] };

const paths: Record<IconName, React.ReactNode> = {
  grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/></>,
  route: <><circle cx="5" cy="6" r="2"/><circle cx="19" cy="18" r="2"/><path d="M7 6h5a3 3 0 0 1 0 6H9a3 3 0 0 0-3 3v1"/></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></>,
  file: <><path d="M5 3h9l5 5v13H5z"/><path d="M14 3v6h5M8 13h8M8 17h6"/></>, chart: <><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.4 1A7 7 0 0 0 15 6.2L14.6 3h-4L10 6.2a7 7 0 0 0-1.5.9l-2.4-1-2 3.4L6 11a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.4-1a7 7 0 0 0 1.5.9l.5 3.2h4l.5-3.2a7 7 0 0 0 1.5-.9l2.4 1 2-3.4-2-1.5c.1-.3.2-.7.2-1z"/></>,
  search: <><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></>, download: <><path d="M12 4v12m0 0 5-5m-5 5-5-5"/><path d="M4 20h16"/></>,
  upload: <><path d="M12 16V4m0 0L7 9m5-5 5 5"/><path d="M4 15v5h16v-5"/></>, chevron: <path d="m9 18 6-6-6-6"/>, shield: <path d="M12 3 4 6v5c0 5 3.4 8.6 8 10 4.6-1.4 8-5 8-10V6z"/>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>, check: <path d="m5 12 4 4L19 6"/>, close: <path d="m6 6 12 12M18 6 6 18"/>,
  external: <><path d="M14 4h6v6M20 4l-9 9"/><path d="M19 14v6H4V5h6"/></>, info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>,
  trash: <><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/></>, history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></>,
  user: <><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></>, refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M7 8a7 7 0 0 1 11.5-1L20 12M4 12l1.5 5A7 7 0 0 0 17 16"/></>,
};
const nav: { id: View; label: string; icon: IconName }[] = [{ id: "dashboard", label: "Painel", icon: "grid" }, { id: "trails", label: "Trilhas", icon: "route" }, { id: "alerts", label: "Alertas", icon: "bell" }, { id: "publications", label: "Publicações", icon: "file" }, { id: "files", label: "Arquivos", icon: "database" }, { id: "settings", label: "Configurações", icon: "settings" }];
const statuses: AlertStatus[] = ["Novo", "Em análise", "Validado", "Descartado"];

function Icon({ name, size = 18 }: { name: IconName; size?: number }) { return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>; }
function slug(value: string) { return value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "-"); }
function fmtDate(value?: string, full = false) { if (!value) return "—"; const date = new Date(value.includes("/") ? value.split("/").reverse().join("-") + "T12:00:00" : value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString("pt-BR", full ? { dateStyle: "short", timeStyle: "short" } : { dateStyle: "short" }); }
function fileSize(value: number) { return value < 1024 * 1024 ? `${(value / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} KB` : `${(value / 1024 / 1024).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} MB`; }
function safeExternalUrl(value?: string) { return value && /^https?:\/\//i.test(value.trim()) ? value.trim() : ""; }
function Score({ score }: { score: number }) { const severity = severityFrom(score); return <span className={`score severity-${slug(severity)}`}><strong>{score}</strong><small>{severity}</small></span>; }
function Button({ children, primary = false, danger = false, disabled = false, onClick }: { children: React.ReactNode; primary?: boolean; danger?: boolean; disabled?: boolean; onClick?: () => void }) { return <button disabled={disabled} className={`btn${primary ? " primary" : ""}${danger ? " danger" : ""}`} onClick={onClick}>{children}</button>; }
function Heading({ eyebrow, title, text, children }: { eyebrow: string; title: string; text: string; children?: React.ReactNode }) { return <div className="heading"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{text}</p></div>{children && <div className="heading-actions">{children}</div>}</div>; }
function Kpi({ label, value, help, tone, icon, onClick }: { label: string; value: React.ReactNode; help: string; tone: string; icon: IconName; onClick?: () => void }) {
  const content = <><header><span>{label}</span><b><Icon name={icon}/></b></header><strong>{value}</strong><small>{help}</small></>;
  return onClick
    ? <button type="button" className={`kpi tone-${tone} kpi-action`} onClick={onClick}>{content}</button>
    : <article className={`kpi tone-${tone}`}>{content}</article>;
}
function PanelHead({ eyebrow, title, children }: { eyebrow: string; title: string; children?: React.ReactNode }) { return <header className="panel-head"><div><p className="eyebrow">{eyebrow}</p><h2>{title}</h2></div>{children}</header>; }
function Empty({ icon = "database", title, text, action }: { icon?: IconName; title: string; text: string; action?: React.ReactNode }) { return <div className="empty"><span><Icon name={icon} size={26}/></span><h3>{title}</h3><p>{text}</p>{action}</div>; }

function t09Terms(alert: Pick<AuditAlert, "trailId" | "evidence">) {
  if (alert.trailId !== "T09") return [];
  const evidence = alert.evidence.find((item) => /^Termos localizados:/i.test(item));
  return evidence ? sanitizeInterestTerms(evidence.replace(/^Termos localizados:\s*/i, "")) : [];
}

function HighlightedAlertText({ alert, text }: { alert: Pick<AuditAlert, "trailId" | "evidence">; text: string }) {
  const terms = t09Terms(alert);
  if (!terms.length || !text) return <>{text}</>;
  const escapedTerms = terms
    .slice()
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const matcher = new RegExp(`(${escapedTerms.join("|")})`, "gi");
  const normalizedTerms = new Set(terms.map((term) => term.toLocaleLowerCase("pt-BR")));
  return <>{text.split(matcher).map((part, index) => normalizedTerms.has(part.toLocaleLowerCase("pt-BR"))
    ? <mark className="t09-highlight" key={`${part}-${index}`}>{part}</mark>
    : part)}</>;
}

export default function Home() {
  const [view, setView] = useState<View>("dashboard");
  const [data, setData] = useState<AppState | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(""), [error, setError] = useState("");
  const [query, setQuery] = useState(""), [severity, setSeverity] = useState("Todas"), [statusFilter, setStatusFilter] = useState("Todos"), [trailFilter, setTrailFilter] = useState("Todas");
  const [selected, setSelected] = useState<StoredAlert | null>(null);
  const [draft, setDraft] = useState({ status: "Novo" as AlertStatus, notes: "", assignedTo: "", dueDate: "" });
  const [settingsDraft, setSettingsDraft] = useState<SettingsDraft>({ materiality: "500000", publicationLag: "30", retentionDays: "1825", interestTerms: [...DEFAULT_INTEREST_TERMS] });
  const [batchSelection, setBatchSelection] = useState<string[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  async function parseResponse(response: Response) { const body = await response.json(); if (!response.ok) throw new Error(body.error || "A operação não pôde ser concluída."); return body; }
  function applyState(state: AppState) { setData(state); setBatchSelection(state.activeBatches.map((batch) => batch.id)); setSelected(null); return state; }
  function openAlert(alert: StoredAlert) { setSelected(alert); setDraft({ status: alert.status, notes: alert.notes || "", assignedTo: alert.assignedTo || "", dueDate: alert.dueDate || "" }); }
  async function uploadFile(file?: File, silent = false) {
    if (!file) return; setBusy(true); setError(""); if (!silent) setNotice("Validando, armazenando localmente e processando o arquivo…");
    try { const body = await parseResponse(await fetch("/api/imports", { method: "POST", headers: { "Content-Type": file.type || "text/csv", "X-File-Name": encodeURIComponent(file.name), "X-Imported-By": encodeURIComponent("ASTID · CENCIAR") }, body: file })); applyState(body.state); setNotice(body.duplicate ? "Arquivo já existente. O lote foi reativado sem duplicação." : `${body.state.activeBatch.rowCount} publicações persistidas e ${body.state.activeBatch.alertCount} alertas gerados.`); if (!silent) setView("dashboard"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Falha no upload."); setNotice(""); }
    finally { setBusy(false); if (fileRef.current) fileRef.current.value = ""; }
  }
  useEffect(() => {
    let cancelled = false;
    async function initialize() {
      try {
        const state = await parseResponse(await fetch("/api/state", { cache: "no-store" })) as AppState;
        if (cancelled) return;
        applyState(state);
        setSettingsDraft({ materiality: state.settings.materiality || "500000", publicationLag: state.settings.publicationLag || "30", retentionDays: state.settings.retentionDays || "1825", interestTerms: parseInterestTerms(state.settings.interestTerms) });
        if (state.activeBatch?.status === "Incompleto") setError("O lote anterior não foi concluído. Reenvie o mesmo arquivo: o sistema removerá a carga incompleta e fará o processamento integral.");
      } catch (cause) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Falha ao abrir a base persistente.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void initialize();
    return () => { cancelled = true; };
    // A inicialização é executada uma vez; as operações posteriores atualizam o estado diretamente.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeTrailIds = useMemo(() => new Set((data?.trails || []).filter((trail) => trail.active).map((trail) => trail.id)), [data?.trails]);
  const alerts = useMemo(() => (data?.alerts || []).filter((alert) => activeTrailIds.has(alert.trailId)), [data?.alerts, activeTrailIds]);
  const publications = data?.publications || [];
  const critical = alerts.filter((alert) => alert.severity === "Crítico").length, high = alerts.filter((alert) => alert.severity === "Alto").length, concluded = alerts.filter((alert) => ["Validado", "Descartado"].includes(alert.status)).length;
  const total = publications.reduce((sum, publication) => sum + (publication.value || 0), 0), processes = new Set(publications.map((publication) => publication.process).filter(Boolean)).size, uasgs = new Set(publications.map((publication) => publication.uasg).filter(Boolean)).size;
  const counts = (["Crítico", "Alto", "Médio", "Baixo"] as Severity[]).map((name) => ({ name, count: alerts.filter((alert) => alert.severity === name).length }));
  const shownAlerts = alerts.filter((alert) => {
    const publication = publications.find((item) => item.id === alert.publicationId);
    const searchable = `${alert.title} ${alert.reason} ${publication?.process || ""} ${publication?.uasg || ""} ${publication?.uasgName || ""} ${publication?.contractingParty || ""} ${publication?.contractedParty || ""}`;
    return (severity === "Todas" || alert.severity === severity)
      && (statusFilter === "Todos" || alert.status === statusFilter)
      && (trailFilter === "Todas" || alert.trailId === trailFilter)
      && searchable.toLowerCase().includes(query.toLowerCase());
  });
  const shownPublications = publications.filter((publication) => `${publication.title} ${publication.category} ${publication.process} ${publication.cnpj} ${publication.uasg} ${publication.uasgName || ""} ${publication.supplier} ${publication.contractingParty} ${publication.contractedParty} ${publication.object}`.toLowerCase().includes(query.toLowerCase()));

  async function analyzeBatches(ids: string[]) {
    if (!ids.length) { setError("Selecione ao menos um arquivo para análise."); return; }
    setBusy(true); setError(""); setNotice("Carregando a análise consolidada…");
    try {
      const body = await parseResponse(await fetch("/api/imports/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) }));
      applyState(body.state);
      setNotice(`${ids.length === 1 ? "Arquivo carregado" : `${ids.length} arquivos analisados em conjunto`}: ${body.state.publications.length} publicações e ${body.state.alerts.length} alertas disponíveis.`);
      setView("dashboard");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao carregar os arquivos para análise."); setNotice(""); }
    finally { setBusy(false); }
  }
  async function deleteBatch(batch: Batch) { if (!window.confirm(`Excluir o lote ${batch.fileName}? O arquivo, as publicações, os alertas e o histórico desse lote serão removidos.`)) return; setBusy(true); try { const body = await parseResponse(await fetch(`/api/imports/${batch.id}`, { method: "DELETE" })); applyState(body.state); setNotice("Lote e registros vinculados excluídos."); } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao excluir lote."); } finally { setBusy(false); } }
  async function toggleTrail(trail: Trail) { try { const body = await parseResponse(await fetch(`/api/trails/${trail.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ active: !trail.active }) })); setData((current) => current ? { ...current, trails: current.trails.map((item) => item.id === trail.id ? body.trail : item) } : current); } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao atualizar trilha."); } }
  async function saveAlert() { if (!selected) return; setBusy(true); try { const body = await parseResponse(await fetch(`/api/alerts/${selected.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...draft, actor: "ASTID · CENCIAR" }) })); setData((current) => current ? { ...current, alerts: current.alerts.map((alert) => alert.id === selected.id ? body.alert : alert), events: [{ id: crypto.randomUUID(), alertId: selected.id, action: selected.status === draft.status ? "Anotação atualizada" : "Status alterado", fromStatus: selected.status, toStatus: draft.status, note: draft.notes, actor: "ASTID · CENCIAR", createdAt: new Date().toISOString() }, ...current.events] } : current); setSelected(body.alert); setNotice("Análise salva com rastreabilidade."); } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao salvar análise."); } finally { setBusy(false); } }
  async function saveSettings() { setBusy(true); try { const body = await parseResponse(await fetch("/api/settings", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settingsDraft) })); applyState(body.state); setSettingsDraft((current) => ({ ...current, interestTerms: parseInterestTerms(body.state.settings.interestTerms) })); setNotice("Parâmetros salvos. A T09 foi recalculada nos arquivos em análise."); } catch (cause) { setError(cause instanceof Error ? cause.message : "Falha ao salvar parâmetros."); } finally { setBusy(false); } }
  function exportAlerts() { const header = ["ID", "Trilha", "Severidade", "Score", "Status", "Responsável", "Prazo", "Título", "Processo", "UASG", "Nome da UASG", "UF da UASG", "Contratante", "Contratada", "Valor", "Motivo", "Observações", "URL"]; const records = alerts.map((alert) => { const publication = publications.find((item) => item.id === alert.publicationId); return [alert.id, alert.trailId, alert.severity, alert.score, alert.status, alert.assignedTo, alert.dueDate, alert.title, publication?.process, publication?.uasg, publication?.uasgName, publication?.uasgUf, publication?.contractingParty, publication?.contractedParty, publication?.value, alert.reason, alert.notes, publication?.url]; }); const csv = [header, ...records].map((row) => row.map((value) => `"${String(value ?? "").replace(/"/g, '""')}"`).join(";")).join("\n"); const link = document.createElement("a"); link.href = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" })); link.download = `alertas_${data?.activeBatch?.fileName.replace(/\.csv$/i, "") || "audtrilhas"}.csv`; link.click(); URL.revokeObjectURL(link.href); }

  if (loading) return <div className="loading-screen"><img className="loading-seal" src="/cenciar-bolacha.png" alt="Símbolo do CENCIAR"/><strong>AudTrilhas DOU</strong><p>Abrindo a base local…</p></div>;
  return <div className="app"><input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(event) => uploadFile(event.target.files?.[0])}/>
    <aside className="sidebar"><div className="brand"><div className="brand-icon"><img src="/cenciar-bolacha.png" alt="Símbolo do CENCIAR"/></div><div><strong>AudTrilhas <b>DOU</b></strong><small>Auditoria Contínua</small></div></div><nav>{nav.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => { setView(item.id); setQuery(""); }}><Icon name={item.icon}/><span>{item.label}</span>{item.id === "alerts" && critical + high > 0 && <em>{critical + high}</em>}</button>)}</nav><div className="sidebar-astid"><img src="/astid-logo.png" alt="Logomarca da ASTID"/></div></aside>
    <header className="topbar"><span className="avatar">AST</span></header>
    <main className="content">{(notice || error) && <div className={`banner ${error ? "error" : ""}`}><Icon name={error ? "info" : "check"}/><span>{error || notice}</span><button onClick={() => { setNotice(""); setError(""); }}><Icon name="close"/></button></div>}
      {view === "dashboard" && <Dashboard
        data={data}
        alerts={alerts}
        publications={publications}
        critical={critical}
        high={high}
        concluded={concluded}
        total={total}
        processes={processes}
        uasgs={uasgs}
        counts={counts}
        setView={setView}
        setSelected={openAlert}
        openTrail={(id) => { setTrailFilter(id); setView("alerts"); }}
        openSeverity={(name) => { setSeverity(name); setStatusFilter("Todos"); setTrailFilter("Todas"); setView("alerts"); }}
        openUasg={(uasg) => { setQuery(uasg === "Não extraída" ? "" : uasg); setView("publications"); }}
        openCategory={(category) => { setQuery(category); setView("publications"); }}
      />}
      {view === "files" && <Files data={data} busy={busy} onUpload={() => fileRef.current?.click()} uploadFile={uploadFile} selection={batchSelection} setSelection={setBatchSelection} analyzeBatches={analyzeBatches} deleteBatch={deleteBatch}/>}
      {view === "trails" && <Trails trails={data?.trails || []} alerts={data?.alerts || []} toggleTrail={toggleTrail} openTrail={(id) => { setTrailFilter(id); setView("alerts"); }}/>} 
      {view === "alerts" && <Alerts alerts={shownAlerts} total={alerts.length} publications={publications} trails={data?.trails || []} query={query} setQuery={setQuery} severity={severity} setSeverity={setSeverity} statusFilter={statusFilter} setStatusFilter={setStatusFilter} trailFilter={trailFilter} setTrailFilter={setTrailFilter} open={openAlert} exportAlerts={exportAlerts}/>}
      {view === "publications" && <Publications publications={shownPublications} total={publications.length} query={query} setQuery={setQuery} batch={data?.activeBatch} batchCount={data?.activeBatches.length || 0}/>}
      {view === "settings" && <Settings draft={settingsDraft} setDraft={setSettingsDraft} save={saveSettings} busy={busy} data={data}/>} 
    </main>{selected && <AlertDrawer alert={selected} publication={publications.find((item) => item.id === selected.publicationId)} events={(data?.events || []).filter((event) => event.alertId === selected.id)} draft={draft} setDraft={setDraft} close={() => setSelected(null)} save={saveAlert} busy={busy}/>}</div>;
}

function Dashboard({ data, alerts, publications, critical, high, concluded, total, processes, uasgs, counts, setView, setSelected, openTrail, openSeverity, openUasg, openCategory }: { data: AppState | null; alerts: StoredAlert[]; publications: StoredPublication[]; critical: number; high: number; concluded: number; total: number; processes: number; uasgs: number; counts: { name: Severity; count: number }[]; setView: (view: View) => void; setSelected: (alert: StoredAlert) => void; openTrail: (id: string) => void; openSeverity: (name: Severity) => void; openUasg: (uasg: string) => void; openCategory: (category: string) => void }) {
  const maxRisk = Math.max(...counts.map((item) => item.count), 1);
  const openAlerts = alerts.filter((alert) => !["Validado", "Descartado"].includes(alert.status));
  const incomplete = publications.filter((publication) => !publication.process || !publication.uasg || !publication.url).length;
  const categoryColors = ["#176fbd", "#e2a72a", "#23a27d", "#d14a5b", "#7256b8", "#27a4b8", "#dc7a2b", "#7f8c99", "#395e83"];
  const categoryMap = new Map<string, number>();
  publications.forEach((publication) => { const category = publication.category || "Não classificada"; categoryMap.set(category, (categoryMap.get(category) || 0) + 1); });
  const categoryCounts = [...categoryMap.entries()].map(([name, count], index) => ({ name, count, color: categoryColors[index % categoryColors.length] })).sort((a, b) => b.count - a.count);
  let categoryCursor = 0;
  const categoryStops = categoryCounts.map((item) => { const start = categoryCursor; categoryCursor += publications.length ? item.count / publications.length * 100 : 0; return `${item.color} ${start}% ${categoryCursor}%`; }).join(", ");
  const trailCounts = (data?.trails || []).map((trail) => ({ id: trail.id, name: trail.name, count: alerts.filter((alert) => alert.trailId === trail.id).length })).filter((item) => item.count > 0).sort((a, b) => b.count - a.count);
  const maxTrail = Math.max(...trailCounts.map((item) => item.count), 1);
  const publicationById = new Map(publications.map((publication) => [publication.id, publication]));
  const uasgMap = new Map<string, { label: string; name: string; alerts: number; publications: number; value: number }>();
  publications.forEach((publication) => { const label = publication.uasg || "Não extraída"; const current = uasgMap.get(label) || { label, name: publication.uasgName || "", alerts: 0, publications: 0, value: 0 }; current.publications += 1; current.value += publication.value || 0; uasgMap.set(label, current); });
  alerts.forEach((alert) => { const label = publicationById.get(alert.publicationId)?.uasg || "Não extraída"; const current = uasgMap.get(label) || { label, name: publicationById.get(alert.publicationId)?.uasgName || "", alerts: 0, publications: 0, value: 0 }; current.alerts += 1; uasgMap.set(label, current); });
  const uasgRanking = [...uasgMap.values()].sort((a, b) => b.alerts - a.alerts || b.value - a.value).slice(0, 6);
  const maxUasg = Math.max(...uasgRanking.map((item) => item.alerts), 1);
  const materiality = Number(data?.settings.materiality || 500000);
  const valueBands = [
    { label: "Sem valor", test: (value: number | null) => value === null },
    { label: "Abaixo do corte", test: (value: number | null) => value !== null && value < materiality },
    { label: "Acima do corte", test: (value: number | null) => value !== null && value >= materiality },
  ];
  const matrix = counts.map((risk) => ({ severity: risk.name, cells: valueBands.map((band) => alerts.filter((alert) => alert.severity === risk.name && band.test(publicationById.get(alert.publicationId)?.value ?? null)).length) }));
  const matrixMax = Math.max(...matrix.flatMap((row) => row.cells), 1);
  const heatColors: Record<Severity, [number, number, number]> = { "Crítico": [198, 40, 57], "Alto": [224, 105, 34], "Médio": [205, 153, 20], "Baixo": [31, 146, 111] };

  return <><Heading eyebrow="VISÃO EXECUTIVA" title="Painel de Auditoria Contínua" text="Consciência situacional sobre risco, materialidade, concentração e andamento das análises."/>{!data?.activeBatch ? <Empty title="Nenhuma base processada" text="Acesse Arquivos para enviar um CSV do Ro-DOU e iniciar o monitoramento."/> : <>
    <section className="kpis dashboard-kpis" aria-label="Indicadores do painel">
      <Kpi label="PUBLICAÇÕES ANALISADAS" value={publications.length} help={`${processes} processos · ${uasgs} UASGs`} tone="blue" icon="file"/>
      <Kpi label="ALERTAS PRIORITÁRIOS" value={critical + high} help={`${critical} críticos · ${high} altos`} tone="red" icon="bell"/>
      <Kpi label="MATERIALIDADE IDENTIFICADA" value={total >= 1e6 ? `${(total / 1e6).toLocaleString("pt-BR", { maximumFractionDigits: 1 })} mi` : brl(total)} help={`${publications.filter((item) => item.value !== null).length} atos com valor`} tone="gold" icon="chart"/>
      <Kpi label="REGISTROS INCOMPLETOS" value={incomplete} help="Processo, UASG ou link ausente" tone={incomplete ? "gold" : "green"} icon="info" onClick={() => setView("publications")}/>
      <Kpi label="EM ANÁLISE" value={alerts.filter((alert) => alert.status === "Em análise").length} help={`${openAlerts.length} alertas ainda abertos`} tone="blue" icon="history"/>
      <Kpi label="ANÁLISES CONCLUÍDAS" value={`${alerts.length ? Math.round(concluded / alerts.length * 100) : 0}%`} help={`${concluded} de ${alerts.length} alertas`} tone="green" icon="check"/>
    </section>
    <section className="dashboard-grid"><article className="panel"><PanelHead eyebrow="FILA DE TRABALHO" title="Alertas prioritários"><button className="text-btn" onClick={() => setView("alerts")}>Ver todos <Icon name="chevron"/></button></PanelHead><div className="alert-list">{alerts.slice().sort((a, b) => b.score - a.score).slice(0, 6).map((alert) => { const publication = publications.find((item) => item.id === alert.publicationId); return <button className="alert-row" key={alert.id} onClick={() => setSelected(alert)}><Score score={alert.score}/><span className="alert-main"><strong><HighlightedAlertText alert={alert} text={alert.title}/></strong><small>{alert.trailId} · {formatUasg(publication)}</small><em>{publication?.process || "Processo não extraído"}</em></span><span className={`status status-${slug(alert.status)}`}>{alert.status}</span><Icon name="chevron"/></button>; })}</div></article><article className="panel risk"><PanelHead eyebrow="EXPOSIÇÃO" title="Distribuição de risco"><span className="muted">{alerts.length} sinais</span></PanelHead><div className="risk-bars">{counts.map((item) => <button key={item.name} onClick={() => openSeverity(item.name)} aria-label={`Abrir ${item.count} alertas de risco ${item.name}`}><header><span><i className={`dot-${slug(item.name)}`}/>{item.name}</span><strong>{item.count}</strong></header><p><i className={`bar-${slug(item.name)}`} style={{ width: `${item.count / maxRisk * 100}%` }}/></p></button>)}</div><div className="human"><Icon name="info"/><span>O score orienta a triagem. A conclusão depende de análise humana e evidências suficientes e adequadas.</span></div></article></section>
    <section className="insight-grid"><article className="panel"><PanelHead eyebrow="TIPOS DE PUBLICAÇÃO" title="Composição das publicações"><span className="muted">{categoryCounts.length} tipos</span></PanelHead><div className="status-chart publication-type-chart"><button className="status-donut" onClick={() => { setView("publications"); }} style={{ background: publications.length ? `conic-gradient(${categoryStops})` : "#e8eef4" }} aria-label={`${publications.length} publicações analisadas em ${categoryCounts.length} tipos`}><i><strong>{publications.length}</strong><span>publicações</span></i></button><div className="status-legend publication-type-legend">{categoryCounts.map((item) => <button key={item.name} onClick={() => openCategory(item.name)} title={`Abrir publicações do tipo ${item.name}`}><i style={{ background: item.color }}/><span>{item.name}</span><strong>{item.count}</strong></button>)}</div></div></article><article className="panel"><PanelHead eyebrow="COBERTURA" title="Alertas por trilha"><span className="muted">{trailCounts.length} trilhas acionadas</span></PanelHead><div className="trail-bars">{trailCounts.map((item) => <button key={item.id} onClick={() => openTrail(item.id)}><header><span><b>{item.id}</b>{item.name}</span><strong>{item.count}</strong></header><p><i style={{ width: `${item.count / maxTrail * 100}%` }}/></p></button>)}</div></article></section>
    <section className="insight-grid lower"><article className="panel"><PanelHead eyebrow="CONCENTRAÇÃO" title="Exposição por UASG"><span className="muted">Top {uasgRanking.length}</span></PanelHead><div className="uasg-bars">{uasgRanking.map((item) => <button key={item.label} onClick={() => openUasg(item.label)}><span className="uasg-rank"><b>{item.label}</b><small>{item.name || "Nome não identificado"}</small></span><span className="uasg-bar"><i style={{ width: `${item.alerts / maxUasg * 100}%` }}/></span><span className="uasg-metrics"><strong>{item.alerts} alertas</strong><small>{item.publications} atos · {item.value ? brl(item.value) : "sem valor"}</small></span></button>)}</div></article><article className="panel"><PanelHead eyebrow="PRIORIZAÇÃO" title="Risco × materialidade"><span className="muted">Corte {brl(materiality)}</span></PanelHead><div className="risk-matrix"><div className="matrix-head"><span/><span>Sem valor</span><span>Abaixo</span><span>Acima</span></div>{matrix.map((row) => <div className="matrix-row" key={row.severity}><strong><i className={`dot-${slug(row.severity)}`}/>{row.severity}</strong>{row.cells.map((value, index) => { const [r, g, b] = heatColors[row.severity]; const alpha = value ? .18 + value / matrixMax * .72 : .04; return <button key={valueBands[index].label} onClick={() => openSeverity(row.severity)} style={{ background: `rgba(${r},${g},${b},${alpha})` }} aria-label={`${value} alertas ${row.severity}, ${valueBands[index].label}`}><b>{value}</b><small>alertas</small></button>; })}</div>)}</div><div className="matrix-note"><Icon name="info"/><span>A matriz cruza severidade do sinal com o valor do ato para apoiar a ordem de análise.</span></div></article></section>
    <section className="panel batch-summary"><div><span><Icon name="database"/></span><p><small>{data.activeBatches.length > 1 ? "ANÁLISE CONSOLIDADA" : "LOTE ATIVO"}</small><strong>{data.activeBatches.length > 1 ? `${data.activeBatches.length} arquivos analisados em conjunto` : data.activeBatch.fileName}</strong><em>{data.activeBatches.length > 1 ? "Publicações e alertas apresentados sem separação por arquivo" : `Importado em ${fmtDate(data.activeBatch.createdAt, true)} por ${data.activeBatch.importedBy}`}</em></p></div><div className="batch-stats"><p><strong>{data.batches.length}</strong><span>lotes preservados</span></p><p><strong>{data.activeBatch.rowCount}</strong><span>{data.activeBatches.length > 1 ? "registros consolidados" : "registros no lote"}</span></p><button onClick={() => setView("files")}>Gerenciar base <Icon name="chevron"/></button></div></section>
  </>}</>;
}

function Files({ data, busy, onUpload, uploadFile, selection, setSelection, analyzeBatches, deleteBatch }: { data: AppState | null; busy: boolean; onUpload: () => void; uploadFile: (file?: File) => void; selection: string[]; setSelection: React.Dispatch<React.SetStateAction<string[]>>; analyzeBatches: (ids: string[]) => void; deleteBatch: (batch: Batch) => void }) {
  const batches = data?.batches || [];
  const selectedIds = new Set(selection);
  const allSelected = batches.length > 0 && batches.every((batch) => selectedIds.has(batch.id));
  const toggleSelection = (id: string) => setSelection((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  return <>
    <Heading eyebrow="GESTÃO DA BASE" title="Arquivos e lotes de processamento" text="Selecione um ou vários arquivos armazenados e analise todos os dados em uma única visão consolidada."/>
    <section className="file-layout"><article className={`panel dropzone ${busy ? "busy" : ""}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); uploadFile(event.dataTransfer.files?.[0]); }}><span className="upload-symbol"><Icon name="upload" size={29}/></span><h2>{busy ? "Processando arquivo…" : "Arraste o CSV do Ro-DOU"}</h2><p>O original é armazenado, as publicações são normalizadas e as trilhas geram alertas rastreáveis na base institucional.</p><Button primary disabled={busy} onClick={onUpload}>Selecionar arquivo</Button><small>CSV · até 25 MB · UTF-8 ou Windows-1252</small></article><article className="panel control-card"><p className="eyebrow">CONTROLES DO INGESTOR</p><h2>Do arquivo à auditoria contínua</h2>{[["check", "Validação", "Cabeçalhos, codificação e integridade"], ["database", "Persistência", "Original e dados estruturados"], ["route", "Processamento", "Nove trilhas determinísticas"], ["history", "Rastreabilidade", "Lotes e decisões preservados"]].map(([icon, title, text]) => <div key={title}><span><Icon name={icon as IconName}/></span><p><strong>{title}</strong><small>{text}</small></p></div>)}<footer><Icon name="shield"/> Uploads não são enviados a serviços externos.</footer></article></section>
    <section className="panel batches">
      <PanelHead eyebrow="ACERVO" title="Histórico de arquivos"><span className="muted">{batches.length} lotes · {data?.activeBatches.length || 0} em análise</span></PanelHead>
      {batches.length ? <>
        <div className="batch-selection-bar">
          <div><strong>{selection.length} {selection.length === 1 ? "arquivo selecionado" : "arquivos selecionados"}</strong><span>Ao analisar, publicações e alertas serão apresentados juntos, sem separação por arquivo.</span></div>
          <div><button type="button" className="selection-clear" disabled={!selection.length || busy} onClick={() => setSelection([])}>Limpar seleção</button><Button primary disabled={!selection.length || busy} onClick={() => analyzeBatches(selection)}><Icon name="chart"/>{busy ? "Carregando…" : selection.length === 1 ? "Analisar arquivo" : `Analisar ${selection.length} arquivos`}</Button></div>
        </div>
        <div className="batch-table">
          <div className="table-head"><span>Arquivo</span><span>Processamento</span><span>Registros</span><span>Responsável</span><span className="batch-actions-head"><label><input type="checkbox" checked={allSelected} onChange={() => setSelection(allSelected ? [] : batches.map((batch) => batch.id))} disabled={busy}/><span>Todos</span></label>Ações</span></div>
          {batches.map((batch) => <div className={`batch-row ${batch.isActive ? "active" : ""} ${selectedIds.has(batch.id) ? "selected" : ""}`} key={batch.id}><span className="file-cell"><i><Icon name="file"/></i><span><strong>{batch.fileName}</strong><small>{fileSize(batch.fileSize)} · SHA-256 {batch.checksum.slice(0, 10)}…</small></span></span><span><strong>{fmtDate(batch.createdAt, true)}</strong><small className="processed"><i/> {batch.status}</small></span><span><strong>{batch.rowCount} publicações</strong><small>{batch.alertCount} alertas gerados</small></span><span><strong>{batch.importedBy}</strong><small>{batch.isActive ? "Incluído na análise" : "Histórico"}</small></span><span className="row-actions"><label className="batch-choice" title="Selecionar para análise"><input type="checkbox" checked={selectedIds.has(batch.id)} onChange={() => toggleSelection(batch.id)} disabled={busy}/><span aria-hidden="true"><Icon name="check" size={15}/></span><em className="sr-only">Selecionar {batch.fileName} para análise</em></label><a href={`/api/imports/${batch.id}/file`} title="Baixar original"><Icon name="download"/></a><button disabled={busy} className="danger-icon" onClick={() => deleteBatch(batch)} title="Excluir lote"><Icon name="trash"/></button></span></div>)}
        </div>
      </> : <Empty title="Nenhum arquivo armazenado" text="Envie o primeiro CSV para criar a base persistente."/>}
    </section>
  </>;
}

function Trails({ trails, alerts, toggleTrail, openTrail }: { trails: Trail[]; alerts: StoredAlert[]; toggleTrail: (trail: Trail) => void; openTrail: (id: string) => void }) {
  const iconForTrail = (id: string): IconName => id === "T01" ? "chart" : id === "T04" ? "clock" : id === "T05" ? "shield" : id === "T09" ? "search" : "route";
  return <>
    <Heading eyebrow="MOTOR DE CONTROLE" title="Trilhas de auditoria" text="Regras transparentes, persistentes e supervisionadas para seleção orientada a risco.">
      <span className="active-pill"><i/> {trails.filter((trail) => trail.active).length} trilhas ativas</span>
    </Heading>
    <section className="trail-grid">{trails.map((trail) => <article className={`trail-card ${trail.active ? "" : "inactive"}`} key={trail.id}>
      <header><span className="trail-icon"><Icon name={iconForTrail(trail.id)}/></span><b>{trail.id}</b><label className="switch" title={trail.active ? "Desativar trilha" : "Ativar trilha"}><input type="checkbox" checked={trail.active} onChange={() => toggleTrail(trail)}/><span/></label></header>
      <small>{trail.category}</small><h2>{trail.name}</h2><p>{trail.description}</p>
      <footer><strong>{alerts.filter((alert) => alert.trailId === trail.id).length}</strong><span>ocorrências na análise</span><button onClick={() => openTrail(trail.id)}>Examinar <Icon name="chevron"/></button></footer>
    </article>)}</section>
    <div className="method"><Icon name="shield" size={24}/><div><strong>Princípio de uso responsável</strong><p>As trilhas geram sinais para priorização. Nenhum alerta constitui achado ou irregularidade sem validação, evidência e supervisão do auditor.</p></div></div>
  </>;
}

function Alerts({ alerts, total, publications, trails, query, setQuery, severity, setSeverity, statusFilter, setStatusFilter, trailFilter, setTrailFilter, open, exportAlerts }: { alerts: StoredAlert[]; total: number; publications: StoredPublication[]; trails: Trail[]; query: string; setQuery: (value: string) => void; severity: string; setSeverity: (value: string) => void; statusFilter: string; setStatusFilter: (value: string) => void; trailFilter: string; setTrailFilter: (value: string) => void; open: (alert: StoredAlert) => void; exportAlerts: () => void }) { return <><Heading eyebrow="FILA DE ANÁLISE" title="Alertas gerados" text="Classifique, atribua, valide e documente cada exceção com histórico permanente."><Button onClick={exportAlerts}><Icon name="download"/>Exportar</Button></Heading><div className="filters"><label className="search"><Icon name="search"/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar alerta, processo, UASG, contratante ou contratada…"/></label><label><span>Risco</span><select value={severity} onChange={(event) => setSeverity(event.target.value)}><option>Todas</option><option>Crítico</option><option>Alto</option><option>Médio</option><option>Baixo</option></select></label><label><span>Status</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option>Todos</option>{statuses.map((status) => <option key={status}>{status}</option>)}</select></label><label><span>Trilha</span><select value={trailFilter} onChange={(event) => setTrailFilter(event.target.value)}><option>Todas</option>{trails.filter((trail) => trail.active).map((trail) => <option key={trail.id}>{trail.id}</option>)}</select></label></div><div className="table-meta"><span>{alerts.length} de {total} alertas</span><button onClick={() => { setQuery(""); setSeverity("Todas"); setStatusFilter("Todos"); setTrailFilter("Todas"); }}>Limpar filtros</button></div><section className="data-table alerts-table"><div className="table-head"><span>Risco</span><span>Alerta</span><span>Trilha</span><span>Processo / UASG</span><span>Responsável</span><span>Status</span><span/></div>{alerts.map((alert) => { const publication = publications.find((item) => item.id === alert.publicationId); return <button className="table-row" key={alert.id} onClick={() => open(alert)}><Score score={alert.score}/><span className="cell-main"><strong><HighlightedAlertText alert={alert} text={alert.title}/></strong><small>{alert.reason}</small><ContractParties publication={publication}/></span><span><b className="trail-code">{alert.trailId}</b><small>{alert.trail}</small></span><span><strong>{publication?.process || "—"}</strong><small className="uasg-label">{formatUasg(publication)}</small></span><span><strong>{alert.assignedTo || "Não atribuído"}</strong><small>{alert.dueDate ? `Prazo ${fmtDate(alert.dueDate)}` : "Sem prazo"}</small></span><span className={`status status-${slug(alert.status)}`}>{alert.status}</span><Icon name="chevron"/></button>; })}{!alerts.length && <Empty title="Nenhum alerta encontrado" text="Ajuste os filtros ou ative uma trilha de auditoria."/>}</section></>; }

function Publications({ publications, total, query, setQuery, batch, batchCount }: { publications: StoredPublication[]; total: number; query: string; setQuery: (value: string) => void; batch: Batch | null | undefined; batchCount: number }) { return <><Heading eyebrow="BASE NORMALIZADA" title="Publicações do DOU" text="Consulte o texto original e os campos estruturados dos arquivos em análise."/><div className="filters single"><label className="search"><Icon name="search"/><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar título, processo, CNPJ, UASG, contratante ou contratada…"/></label></div><div className="table-meta"><span>{publications.length} de {total} publicações · {batchCount > 1 ? `análise consolidada de ${batchCount} arquivos` : batch?.fileName || "sem arquivo"}</span></div><section className="data-table pubs-table"><div className="table-head"><span>Publicação</span><span>Identificação</span><span>Contratante / Contratada</span><span>Valor</span><span/></div>{publications.map((publication) => <div className="table-row" key={publication.id}><span className="cell-main"><strong>{publication.title}</strong><small>{publication.date} · {publication.category} · {publication.section}</small></span><span><strong>{publication.process || "Processo não extraído"}</strong><small>{publication.contract ? `Contrato ${publication.contract}` : publication.procurementCode ? `Compra ${publication.procurementCode}` : "—"}</small><small className="uasg-label">{formatUasg(publication)}</small></span><span className="publication-parties"><ContractParties publication={publication}/>{!publication.contractedParty && publication.supplier && <small>Fornecedor citado: {publication.supplier}</small>}<small>Unidade: {publication.unit || publication.organization || "—"}</small><small>{publication.cnpj || publication.object.slice(0, 85)}</small></span><span><strong>{brl(publication.value)}</strong></span>{publication.url ? <a href={publication.url} target="_blank" rel="noreferrer" aria-label="Abrir publicação no DOU"><Icon name="external"/></a> : <span/>}</div>)}{!publications.length && <Empty title="Nenhuma publicação" text="Ajuste a busca ou selecione outros arquivos."/>}</section></>; }

function Settings({ draft, setDraft, save, busy, data }: { draft: SettingsDraft; setDraft: React.Dispatch<React.SetStateAction<SettingsDraft>>; save: () => void; busy: boolean; data: AppState | null }) {
  const [termInput, setTermInput] = useState("");
  const addTerms = () => {
    const additions = sanitizeInterestTerms(termInput);
    if (!additions.length) return;
    setDraft((current) => ({ ...current, interestTerms: sanitizeInterestTerms([...current.interestTerms, ...additions]) }));
    setTermInput("");
  };
  const removeTerm = (term: string) => setDraft((current) => ({ ...current, interestTerms: current.interestTerms.filter((item) => item !== term) }));

  return <>
    <Heading eyebrow="GOVERNANÇA" title="Configurações e controles" text="Administre critérios do motor e os controles de governança.">
      <Button primary disabled={busy} onClick={save}><Icon name="check"/>Salvar parâmetros</Button>
    </Heading>
    <section className="settings-grid">
      <article className="panel setting"><span className="setting-icon"><Icon name="chart"/></span><h2>Materialidade</h2><p>Valor mínimo para a trilha de priorização financeira.</p><label><span>VALOR EM REAIS</span><div><i>R$</i><input type="number" min="0" value={draft.materiality} onChange={(event) => setDraft((current) => ({ ...current, materiality: event.target.value }))}/></div></label></article>
      <article className="panel setting"><span className="setting-icon"><Icon name="clock"/></span><h2>Tempestividade</h2><p>Intervalo máximo entre assinatura e publicação.</p><label><span>LIMITE</span><div><input type="number" min="0" value={draft.publicationLag} onChange={(event) => setDraft((current) => ({ ...current, publicationLag: event.target.value }))}/><i>dias</i></div></label></article>
      <article className="panel setting"><span className="setting-icon"><Icon name="database"/></span><h2>Retenção</h2><p>Referência de prazo para a política de guarda dos lotes.</p><label><span>PERÍODO</span><div><input type="number" min="0" value={draft.retentionDays} onChange={(event) => setDraft((current) => ({ ...current, retentionDays: event.target.value }))}/><i>dias</i></div></label></article>
    </section>
    <section className="panel interest-settings">
      <header className="interest-settings-head">
        <span className="setting-icon"><Icon name="search"/></span>
        <div><p className="eyebrow">TRILHA T09</p><h2>Termos de interesse do CENCIAR</h2><p>Inclua ou retire expressões pesquisadas no título e no resumo de cada publicação.</p></div>
        <strong>{draft.interestTerms.length} {draft.interestTerms.length === 1 ? "termo" : "termos"}</strong>
      </header>
      {draft.interestTerms.length > 0
        ? <div className="term-list">{draft.interestTerms.map((term) => <span key={term}>{term}<button type="button" onClick={() => removeTerm(term)} aria-label={`Retirar o termo ${term}`}>×</button></span>)}</div>
        : <p className="term-empty">Nenhum termo cadastrado. A T09 não gerará alertas enquanto a lista estiver vazia.</p>}
      <div className="term-entry">
        <label htmlFor="interest-term">ADICIONAR TERMOS</label>
        <div><input id="interest-term" value={termInput} onChange={(event) => setTermInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addTerms(); } }} placeholder="Digite um termo ou vários separados por vírgula"/><Button disabled={!termInput.trim()} onClick={addTerms}>Adicionar</Button></div>
        <small>Até 50 termos. Expressões repetidas são consolidadas automaticamente.</small>
      </div>
    </section>
    <p className="settings-note"><Icon name="info"/> Os limiares de risco são aplicados aos próximos lotes. Alterações nos termos recalculam a T09 no lote ativo e são usadas nos próximos arquivos.</p>
    <section className="governance-grid">
      <article className="panel governance"><PanelHead eyebrow="CONTROLES IMPLEMENTADOS" title="Governança de dados"/><div><Icon name="check"/><span>Original preservado em pasta local organizada</span></div><div><Icon name="check"/><span>Metadados e decisões no banco SQLite</span></div><div><Icon name="check"/><span>Integridade por hash SHA-256 e controle de duplicação</span></div><div><Icon name="check"/><span>Histórico de status, observações e responsável</span></div><div><Icon name="check"/><span>Exclusão controlada e supervisão humana</span></div></article>
      <article className="panel governance"><PanelHead eyebrow="ADERÊNCIA INSTITUCIONAL" title="Fundamentos"/><div><Icon name="shield"/><span>RICA 21-242: gestão de bases com qualidade, governança e integridade</span></div><div><Icon name="route"/><span>Auditoria contínua orientada por dados e riscos</span></div><div><Icon name="history"/><span>Evidências suficientes, adequadas e rastreáveis</span></div><div><Icon name="user"/><span>Responsabilidade decisória preservada com o auditor</span></div><footer>{data?.batches.length || 0} lotes · {data?.trails.filter((trail) => trail.active).length || 0} trilhas ativas</footer></article>
    </section>
  </>;
}

function ContractParties({ publication }: { publication?: Publication }) {
  return <span className="contract-parties">
    <span className="contract-party">
      <b>Contratante</b>
      <span>{publication?.contractingParty || "Não identificado"}</span>
    </span>
    <span className="contract-party">
      <b>Contratada</b>
      <span>{publication?.contractedParty || "Não identificado"}</span>
    </span>
  </span>;
}

function AlertDrawer({ alert, publication, events, draft, setDraft, close, save, busy }: { alert: StoredAlert; publication?: StoredPublication; events: AuditEvent[]; draft: { status: AlertStatus; notes: string; assignedTo: string; dueDate: string }; setDraft: React.Dispatch<React.SetStateAction<{ status: AlertStatus; notes: string; assignedTo: string; dueDate: string }>>; close: () => void; save: () => void; busy: boolean }) { const publicationUrl = safeExternalUrl(publication?.url); return <div className="backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}><aside className="drawer"><header><div><Icon name="bell"/> FICHA DE ANÁLISE · {alert.trailId}</div><div className="drawer-header-actions">{publicationUrl && <a className="publication-link" href={publicationUrl} target="_blank" rel="noopener noreferrer" title="Abrir publicação no DOU" aria-label="Abrir publicação original no Diário Oficial da União"><Icon name="external"/><span>Acessar publicação</span></a>}<button className="icon-btn" onClick={close} aria-label="Fechar ficha de análise"><Icon name="close"/></button></div></header><section className="drawer-title"><Score score={alert.score}/><div><h2><HighlightedAlertText alert={alert} text={alert.title}/></h2><p>{alert.reason}</p></div></section><section className="record"><div><span>Processo</span><strong>{publication?.process || "—"}</strong></div><div><span>UASG</span><strong>{formatUasg(publication).replace(/^UASG /, "")}</strong></div><div><span>Contrato</span><strong>{publication?.contract || "—"}</strong></div><div><span>Valor</span><strong>{brl(publication?.value ?? null)}</strong></div></section><section className="drawer-object"><h3>Objeto</h3><p><HighlightedAlertText alert={alert} text={publication?.object || "Não identificado"}/></p></section><section className="drawer-parties"><h3>Partes da contratação</h3><ContractParties publication={publication}/></section><section><h3>Evidências extraídas</h3><ul className="evidence">{alert.evidence.map((item) => { const formatted = formatUasgEvidence(item, publication); return <li key={item}><Icon name="check"/><HighlightedAlertText alert={alert} text={formatted}/></li>; })}</ul></section><section><h3>Procedimento sugerido ao auditor</h3><ol className="procedure">{alert.procedure.map((item, index) => <li key={item}><span>{index + 1}</span><p>{item}</p></li>)}</ol></section><section className="analysis-form"><h3>Registro da análise</h3><div className="status-select">{statuses.map((status) => <button key={status} className={draft.status === status ? "selected" : ""} onClick={() => setDraft((current) => ({ ...current, status }))}>{status}</button>)}</div><label><span>RESPONSÁVEL</span><input value={draft.assignedTo} onChange={(event) => setDraft((current) => ({ ...current, assignedTo: event.target.value }))} placeholder="Nome ou equipe"/></label><label><span>OBSERVAÇÕES E CONCLUSÃO</span><textarea value={draft.notes} onChange={(event) => setDraft((current) => ({ ...current, notes: event.target.value }))} placeholder="Registre evidências complementares, análise e encaminhamento…"/></label></section>{events.length > 0 && <section><h3>Histórico de alterações</h3><div className="timeline">{events.slice(0, 8).map((event) => <div key={event.id}><i/><p><strong>{event.action}</strong><span>{event.fromStatus && event.toStatus ? `${event.fromStatus} → ${event.toStatus}` : event.toStatus}</span><small>{event.actor} · {fmtDate(event.createdAt, true)}</small></p></div>)}</div></section>}<div className="drawer-actions"><Button onClick={close}>Cancelar</Button><Button primary disabled={busy} onClick={save}><Icon name="check"/>Salvar análise</Button></div><p className="disclaimer"><Icon name="info"/> O alerta é indício para validação. A conclusão deve ser fundamentada em evidência suficiente e adequada.</p></aside></div>; }
