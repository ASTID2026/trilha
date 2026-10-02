export type Severity = "Crítico" | "Alto" | "Médio" | "Baixo";
export type AlertStatus = "Novo" | "Em análise" | "Validado" | "Descartado";

export type Publication = {
  id: string;
  searchTerm: string;
  unit: string;
  section: string;
  url: string;
  title: string;
  summary: string;
  date: string;
  category: string;
  uasg: string;
  uasgName?: string;
  uasgUf?: string;
  process: string;
  modality: string;
  procurementCode: string;
  contract: string;
  cnpj: string;
  cnpjs: string[];
  supplier: string;
  organization: string;
  contractingParty: string;
  contractedParty: string;
  object: string;
  value: number | null;
  values: number[];
  signatureDate: string;
  validityStart: string;
  validityEnd: string;
  openingDate: string;
  legalBasis: string;
};

export type AuditAlert = {
  id: string;
  publicationId: string;
  trailId: string;
  trail: string;
  severity: Severity;
  score: number;
  title: string;
  reason: string;
  evidence: string[];
  procedure: string[];
  status: AlertStatus;
};

export const DEFAULT_INTEREST_TERMS = [
  "internacional",
  "exterior",
  "notificação",
  "penalidade",
  "multa",
  "notificada",
  "intimação",
  "imposição",
  "inexigibilidade",
] as const;

function foldForSearch(value: string) {
  return value
    .toLocaleLowerCase("pt-BR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function sanitizeInterestTerms(input: unknown): string[] {
  const candidates = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(/[;,\n]/)
      : [];
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const term = candidate.trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR").slice(0, 60);
    const key = foldForSearch(term);
    if (key.length < 2 || seen.has(key)) continue;
    seen.add(key);
    terms.push(term);
    if (terms.length === 50) break;
  }
  return terms;
}

export function parseInterestTerms(value?: string): string[] {
  if (value === undefined || value === "") return [...DEFAULT_INTEREST_TERMS];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return sanitizeInterestTerms(parsed);
  } catch {
    // Accept legacy comma, semicolon or line-separated values.
  }
  return sanitizeInterestTerms(value);
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function findInterestTerms(publication: Pick<Publication, "title" | "summary">, terms: readonly string[]) {
  const text = foldForSearch(`${publication.title} ${publication.summary}`);
  return sanitizeInterestTerms([...terms]).filter((term) => {
    const normalizedTerm = foldForSearch(term);
    const pattern = escapeRegex(normalizedTerm).replace(/\s+/g, "\\s+");
    return new RegExp(`(^|[^a-z0-9])${pattern}(?=$|[^a-z0-9])`, "i").test(text);
  });
}

export function makeInterestTermAlerts(rows: Publication[], terms: readonly string[]): AuditAlert[] {
  return rows.flatMap((publication) => {
    const matched = findInterestTerms(publication, terms);
    if (!matched.length) return [];
    const priorityTerms = new Set(["notificação", "penalidade", "multa", "notificada", "intimação", "imposição"].map(foldForSearch));
    const score = matched.some((term) => priorityTerms.has(foldForSearch(term))) ? 74 : matched.length >= 3 ? 70 : 62;
    return [{
      id: `T09-${publication.id}`,
      publicationId: publication.id,
      trailId: "T09",
      trail: "Termos de interesse do CENCIAR",
      score,
      severity: severityFrom(score),
      title: `Termos de interesse · ${matched.join(", ")}`,
      reason: "A publicação contém um ou mais termos definidos pelo CENCIAR para acompanhamento temático.",
      evidence: [
        `Termos localizados: ${matched.join(", ")}`,
        `Ato: ${publication.title}`,
        `Processo: ${publication.process || "não extraído"}`,
      ],
      procedure: [
        "Acessar a publicação e confirmar o contexto em que os termos foram utilizados.",
        "Avaliar a pertinência do ato para as competências e trabalhos do CENCIAR.",
        "Registrar a conclusão e, quando necessário, relacionar o ato a outras publicações ou processos.",
      ],
      status: "Novo" as AlertStatus,
    }];
  });
}

export const trailCatalog = [
  { id: "T01", name: "Materialidade financeira", category: "Risco financeiro", description: "Prioriza adjudicações, contratos, credenciamentos e alterações com valores relevantes.", icon: "chart" },
  { id: "T02", name: "Múltiplos certames no mesmo processo", category: "Planejamento", description: "Relaciona licitações distintas vinculadas ao mesmo processo administrativo, objeto ou família de compras.", icon: "route" },
  { id: "T03", name: "Alterações contratuais", category: "Contratações", description: "Monitora termos aditivos, apostilamentos, prorrogações, reajustes e alterações acumuladas.", icon: "file" },
  { id: "T04", name: "Tempestividade da publicação", category: "Transparência", description: "Compara a assinatura do ato com a data de publicação no DOU e identifica intervalos relevantes.", icon: "clock" },
  { id: "T05", name: "Sanções, PAAI e intimações", category: "Integridade", description: "Acompanha penalidades, notificações, intimações, prazos de defesa e efeitos sobre fornecedores.", icon: "shield" },
  { id: "T06", name: "Rescisões e continuidade", category: "Execução contratual", description: "Sinaliza rescisões para exame das causas, impactos operacionais e medidas de continuidade.", icon: "bell" },
  { id: "T07", name: "Credenciamentos e cessões", category: "Contratação excepcional", description: "Seleciona credenciamentos, concessões, autorizações de uso e contratações diretas para validação específica.", icon: "route" },
  { id: "T08", name: "Qualidade cadastral", category: "Qualidade de dados", description: "Identifica processos ausentes, formatos atípicos e campos essenciais não extraídos em atos formalizados.", icon: "file" },
  { id: "T09", name: "Termos de interesse do CENCIAR", category: "Monitoramento temático", description: "Busca termos configuráveis no título e no resumo das publicações para acompanhamento específico.", icon: "search" },
] as const;

export const demoRows: Publication[] = [];

export function brl(value: number | null) {
  return value === null ? "—" : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

export function severityFrom(score: number): Severity {
  if (score >= 85) return "Crítico";
  if (score >= 70) return "Alto";
  if (score >= 50) return "Médio";
  return "Baixo";
}

function parseBrDate(value: string) {
  const match = value?.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  return match ? new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1])) : null;
}

function daysBetween(start: string, end: string) {
  const a = parseBrDate(start);
  const b = parseBrDate(end);
  return a && b ? Math.round((b.getTime() - a.getTime()) / 86_400_000) : 0;
}

function firstMatch(text: string, regex: RegExp, group = 1) {
  return text.match(regex)?.[group]?.trim().replace(/[.;]+$/, "") || "";
}

function moneyToNumber(value: string) {
  return Number(value.replace(/\./g, "").replace(",", "."));
}

function decodeSummary(value: string) {
  return value
    .replace(/<br\s*\/?\s*>/gi, " ")
    .replace(/<\/p>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/\s+/g, " ")
    .trim();
}

// Derive both roles from the preserved summary, including for older imports.
// A bidder, sanctioned company or publishing unit is not necessarily a party.
export function extractContractParties(summary: string) {
  const text = decodeSummary(summary).replace(/\*\*/g, "");
  const fields = [...text.matchAll(/\b(contratante|contratad[oa]|objeto|fundamento legal|vigência|valor(?: total)?(?: atualizado do contrato| do termo aditivo)?|data de assinatura|data de abertura|n[º°]\s*processo|número do contrato|processo|signatários|dotação orçamentária|observações)\s*:/gi)];
  const parties = { contractingParty: "", contractedParty: "" };
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!/^(?:contratante|contratad[oa])$/i.test(field[1])) continue;
    const key = /^contratante$/i.test(field[1]) ? "contractingParty" : "contractedParty";
    const start = field.index! + field[0].length;
    const end = fields[index + 1]?.index ?? text.length;
    const value = text.slice(start, end)
      .replace(/\s*\(COMPRASNET[\s\S]*$/i, "")
      .trim()
      .replace(/[.;,]+$/, "")
      .replace(/\bS\.A$/i, "S.A.");
    if (value && !parties[key]) parties[key] = value;
  }
  return parties;
}

function detectDelimiter(line: string) {
  return [",", ";", "\t"]
    .map((delimiter) => ({ delimiter, count: (line.match(new RegExp(delimiter === "\t" ? "\\t" : `\\${delimiter}`, "g")) || []).length }))
    .sort((a, b) => b.count - a.count)[0].delimiter;
}

export function parseCsv(text: string): Record<string, string>[] {
  const clean = text.replace(/^\uFEFF/, "");
  const delimiter = detectDelimiter(clean.split(/\r?\n/, 1)[0]);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < clean.length; index++) {
    const char = clean[index];
    const next = clean[index + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      index++;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index++;
      row.push(cell);
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }

  const headers = rows.shift()?.map((header) => header.trim()) || [];
  return rows.map((values) => Object.fromEntries(headers.map((header, index) => [header, (values[index] || "").trim()])));
}

function categoryFromTitle(title: string) {
  const normalized = title.toUpperCase();
  if (normalized.includes("LICITAÇÃO")) return "Licitação";
  if (normalized.includes("ADITIVO") || normalized.includes("APOSTILAMENTO")) return "Alteração contratual";
  if (normalized.includes("RESCISÃO")) return "Rescisão";
  if (normalized.includes("PENALIDADE") || normalized.includes("INTIMAÇÃO") || normalized.includes("NOTIFICA")) return "Integridade";
  if (normalized.includes("CREDENCIAMENTO")) return "Credenciamento";
  if (normalized.includes("CONTRATO")) return "Contrato";
  if (normalized.includes("CONCESSÃO") || normalized.includes("AUTORIZAÇÃO DE USO")) return "Cessão de uso";
  if (normalized.includes("ADJUDICAÇÃO") || normalized.includes("HOMOLOGAÇÃO")) return "Homologação";
  return "Outros atos";
}

export function normalizeRows(rawRows: Record<string, string>[]): Publication[] {
  return rawRows.map((raw, index) => {
    const normalizedKeys = new Map(
      Object.keys(raw).map((key) => [key.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, ""), raw[key]])
    );
    const get = (...names: string[]) => names.map((name) => normalizedKeys.get(name)).find((value) => value !== undefined) || "";
    const summary = decodeSummary(get("resumo", "texto", "conteudo"));
    const parties = extractContractParties(summary);
    const title = get("titulo", "tipo") || "PUBLICAÇÃO";
    const procurementCode = firstMatch(summary, /[?&]compra=(\d+)/i);
    const uasg = firstMatch(`${title} ${summary}`, /UASG\s*(\d{6})/i) || (procurementCode ? procurementCode.slice(0, 6) : "");
    const process =
      firstMatch(summary, /(?:Número do processo|Nº Processo|N\.º Processo|Processo)\s*:\s*([\d.\/\-]+)/i) ||
      firstMatch(summary, /\b(\d{5}\.\d{6}\/\d{4}-\d{2})\b/);
    const modality =
      firstMatch(summary, /Modalidade\s*:\s*(.*?)\s*\/\s*(?:Número do processo|Nº Processo)/i) ||
      firstMatch(summary, /((?:Pregão|Concorrência|Inexigibilidade|Dispensa|Credenciamento)\.?\s*(?:Nº|N°)?\s*[\d/.-]+)/i);
    const contract =
      firstMatch(title, /CONTRATO Nº\s*([\w.-]+\/\d{4})/i) ||
      firstMatch(summary, /(?:Número do Contrato|Contrato)\s*:\s*(?:Nº\s*)?([\w.-]+\/\d{4})/i);
    const object = firstMatch(
      summary,
      /Objeto\s*:\s*(.*?)(?=\s+(?:Fundamento Legal|Vigência|Valor Total|Data de Assinatura|Data de Abertura|Endereço eletrônico|Contratante|Contratado)\s*:|$)/i
    );
    const cnpjs = [...new Set([...summary.matchAll(/\d{2}\.\d{3}\.\d{3}[\/.]\d{4}-\d{2}/g)].map((match) => match[0]))];
    const values = [...summary.matchAll(/R\$\s*([\d.]+,\d{2})/gi)].map((match) => moneyToNumber(match[1]));
    const statedTotal = firstMatch(
      summary,
      /(?:preço global final|Valor Total(?: Atualizado do Contrato)?|valor total)\s*(?:de|:)\s*R\$\s*([\d.]+,\d{2})/i
    );
    const validity = summary.match(/Vigência\s*:\s*(\d{2}\/\d{2}\/\d{4})\s*a\s*(\d{2}\/\d{2}\/\d{4})/i);
    const supplier =
      parties.contractedParty.replace(/^(?:\d{2}\.\d{3}\.\d{3}[\/.]\d{4}-\d{2}|\d{14})\s*[-–—]?\s*/, "") ||
      firstMatch(summary, /licitante\s*:\s*(.+?)\s*\(CNPJ/i) ||
      firstMatch(summary, /A empresa\s+(.+?)(?:,|\s+inscrita no CNPJ)/i);
    const organization = parties.contractingParty || get("unidade") || "Comando da Aeronáutica";

    return {
      id: `dou-${index + 1}`,
      searchTerm: get("termo de pesquisa"),
      unit: get("unidade"),
      section: get("secao"),
      url: get("url", "link"),
      title,
      summary,
      date: get("data", "data publicacao", "data de publicacao"),
      category: categoryFromTitle(title),
      uasg,
      process,
      modality,
      procurementCode,
      contract,
      cnpj: cnpjs[0] || "",
      cnpjs,
      supplier,
      organization,
      ...parties,
      object: object || summary.slice(0, 280),
      value: statedTotal ? moneyToNumber(statedTotal) : values.length ? Math.max(...values) : null,
      values,
      signatureDate: firstMatch(summary, /Data de Assinatura\s*:\s*(\d{2}\/\d{2}\/\d{4})/i),
      validityStart: validity?.[1] || "",
      validityEnd: validity?.[2] || "",
      openingDate: firstMatch(summary, /Data de Abertura\s*:\s*(\d{2}\/\d{2}\/\d{4})/i),
      legalBasis: firstMatch(summary, /Fundamento Legal\s*:\s*(.*?)(?=\s+Vigência\s*:|\s+Valor Total|\s+Data de Assinatura|$)/i),
    };
  });
}

export function makeAlerts(rows: Publication[], config: { materiality?: number; publicationLag?: number; interestTerms?: readonly string[] } = {}): AuditAlert[] {
  const materialityThreshold = config.materiality ?? 500_000;
  const publicationLagThreshold = config.publicationLag ?? 30;
  const alerts: AuditAlert[] = [];
  const processCounts = new Map<string, number>();
  const contractCounts = new Map<string, number>();
  const biddingProcessCounts = new Map<string, number>();

  rows.forEach((row) => {
    if (row.process) processCounts.set(row.process, (processCounts.get(row.process) || 0) + 1);
    if (row.contract) {
      const key = `${row.uasg}|${row.contract}`;
      contractCounts.set(key, (contractCounts.get(key) || 0) + 1);
    }
    if (row.process && row.category === "Licitação") {
      biddingProcessCounts.set(row.process, (biddingProcessCounts.get(row.process) || 0) + 1);
    }
  });

  const add = (
    publication: Publication,
    trailId: string,
    trail: string,
    score: number,
    title: string,
    reason: string,
    evidence: string[],
    procedure: string[]
  ) => alerts.push({
    id: `${trailId}-${publication.id}`,
    publicationId: publication.id,
    trailId,
    trail,
    score,
    severity: severityFrom(score),
    title,
    reason,
    evidence,
    procedure,
    status: "Novo",
  });

  rows.forEach((publication) => {
    const text = `${publication.title} ${publication.summary}`.toLowerCase();

    if (publication.value !== null && publication.value >= materialityThreshold) {
      const score = publication.value >= 100_000_000 ? 97 : publication.value >= 10_000_000 ? 90 : publication.value >= 1_000_000 ? 82 : 72;
      add(
        publication,
        "T01",
        "Materialidade financeira",
        score,
        `Materialidade ${score >= 85 ? "crítica" : "alta"} · ${brl(publication.value)}`,
        "O valor extraído do ato supera o limiar de priorização financeira definido para o monitoramento contínuo.",
        [`Valor publicado: ${brl(publication.value)}`, `UASG: ${publication.uasg || "não extraída"}`, `Processo: ${publication.process || "não extraído"}`],
        ["Confirmar o valor e a natureza da despesa no instrumento original.", "Avaliar riscos de preço, orçamento, habilitação e execução conforme o tipo de ato.", "Relacionar a contratação a aditivos, empenhos e pagamentos em ciclos posteriores."]
      );
    }

    if (publication.process && publication.category === "Licitação" && (biddingProcessCounts.get(publication.process) || 0) > 1) {
      add(
        publication,
        "T02",
        "Múltiplos certames no mesmo processo",
        88,
        `Múltiplas licitações · Processo ${publication.process}`,
        "O mesmo processo administrativo foi associado a mais de um aviso de licitação no lote, exigindo consolidação do objeto e da estratégia de contratação.",
        [`Ocorrências no lote: ${biddingProcessCounts.get(publication.process)}`, `Modalidade: ${publication.modality || "não extraída"}`, `Código da compra: ${publication.procurementCode || "não extraído"}`],
        ["Consolidar todos os avisos e itens vinculados ao processo.", "Verificar se há divisão justificável por lotes ou risco de fracionamento indevido.", "Comparar objetos, códigos de compra, datas de abertura e estimativas de valor."]
      );
    }

    if (publication.category === "Alteração contratual") {
      const sameContract = contractCounts.get(`${publication.uasg}|${publication.contract}`) || 0;
      const score = /25(?:,00)?%/.test(text) ? 92 : sameContract > 1 ? 78 : 58;
      add(
        publication,
        "T03",
        "Alterações contratuais",
        score,
        `${publication.title.replace(/\s*-\s*UASG.*$/i, "")}`,
        sameContract > 1 ? "O contrato possui mais de uma alteração publicada no lote, recomendando análise cumulativa." : "Ato altera prazo, valor, equilíbrio econômico-financeiro ou condições do contrato.",
        [`Contrato: ${publication.contract || "não extraído"}`, `Processo: ${publication.process || "não extraído"}`, `Valor atualizado: ${brl(publication.value)}`],
        ["Reconstruir a linha do tempo do contrato e de todas as alterações.", "Recalcular percentuais e impactos acumulados sobre prazo e valor.", "Examinar justificativas, pareceres e autorização da autoridade competente."]
      );
    }

    const publicationLag = daysBetween(publication.signatureDate, publication.date);
    if (publicationLag > publicationLagThreshold) {
      add(
        publication,
        "T04",
        "Tempestividade da publicação",
        publicationLag > 60 ? 86 : 72,
        `Publicação ${publicationLag} dias após a assinatura`,
        `O intervalo entre assinatura e publicação supera ${publicationLagThreshold} dias e pode afetar transparência, eficácia ou controle tempestivo.`,
        [`Assinatura: ${publication.signatureDate}`, `Publicação: ${publication.date}`, `Intervalo: ${publicationLag} dias`],
        ["Confirmar a data de produção de efeitos do instrumento.", "Verificar a motivação para o intervalo e a tempestividade da publicidade.", "Avaliar atos de execução ocorridos antes da publicação."]
      );
    }

    if (/penalidade|edital de\s+notificação|edital de intimação|apuração de irregularidade/.test(text)) {
      const sanction = /penalidade|impedimento de licitar|sancionad|multa aplicada/.test(text);
      add(
        publication,
        "T05",
        "Sanções, PAAI e intimações",
        sanction ? 92 : 78,
        sanction ? `Sanção ou penalidade · ${publication.supplier || publication.cnpj || "fornecedor identificado no ato"}` : `Processo sancionador em acompanhamento`,
        sanction ? "O ato registra penalidade, multa ou impedimento com possíveis reflexos sobre contratações vigentes e futuras." : "A publicação registra notificação ou intimação com prazo processual e necessidade de acompanhamento do desfecho.",
        [`Processo: ${publication.process || "não extraído"}`, `CNPJ principal: ${publication.cnpj || "não extraído"}`, `Ato: ${publication.title}`],
        ["Registrar o marco processual e eventual prazo de defesa ou recurso.", "Confirmar o registro da sanção e seu alcance nos cadastros oficiais.", "Verificar contratações, empenhos ou pagamentos posteriores quando aplicável."]
      );
    }

    if (publication.category === "Rescisão") {
      add(
        publication,
        "T06",
        "Rescisões e continuidade",
        82,
        `Rescisão · Contrato ${publication.contract || "não extraído"}`,
        "A rescisão pode indicar falha de execução, risco de descontinuidade ou necessidade de nova contratação.",
        [`UASG: ${publication.uasg || "não extraída"}`, `Processo: ${publication.process || "não extraído"}`, `Fornecedor: ${publication.supplier || publication.cnpj || "não extraído"}`],
        ["Identificar a causa, natureza e efeitos financeiros da rescisão.", "Verificar sanções, garantias, saldos e providências de continuidade.", "Avaliar concentração de rescisões na mesma UASG e período."]
      );
    }

    if (/credenciamento|autorização de uso|concessão|inexigibilidade|dispensa/.test(text)) {
      const score = publication.value !== null && publication.value >= 1_000_000 ? 82 : 58;
      add(
        publication,
        "T07",
        "Credenciamentos e cessões",
        score,
        `${publication.category} · ${publication.uasg ? `UASG ${publication.uasg}` : "análise específica"}`,
        "O ato utiliza regime de credenciamento, contratação direta, concessão ou autorização de uso e demanda testes próprios de conformidade.",
        [`Modalidade: ${publication.modality || publication.category}`, `Valor: ${brl(publication.value)}`, `CNPJs citados: ${publication.cnpjs.length}`],
        ["Validar hipótese legal, motivação e critérios de seleção.", "Examinar publicidade, isonomia e compatibilidade dos preços.", "Verificar obrigações, contrapartidas, limites e condições de vigência."]
      );
    }

    const formalizedAct = ["Contrato", "Alteração contratual", "Rescisão"].includes(publication.category);
    const compactProcess = publication.process && !/[.\/-]/.test(publication.process);
    if ((formalizedAct && !publication.process) || compactProcess) {
      add(
        publication,
        "T08",
        "Qualidade cadastral",
        55,
        compactProcess ? `Processo em formato não padronizado` : `Processo não extraído do ato`,
        "A identificação do processo está ausente ou em formato atípico, reduzindo a confiabilidade dos cruzamentos e da rastreabilidade.",
        [`Título: ${publication.title}`, `Processo extraído: ${publication.process || "ausente"}`, `URL original preservada: ${publication.url ? "sim" : "não"}`],
        ["Conferir o número no ato original e no sistema corporativo.", "Corrigir ou complementar o identificador antes de cruzamentos.", "Registrar a causa da falha de extração para calibrar o parser."]
      );
    }
  });

  alerts.push(...makeInterestTermAlerts(rows, config.interestTerms ?? DEFAULT_INTEREST_TERMS));
  return alerts.sort((a, b) => b.score - a.score);
}
