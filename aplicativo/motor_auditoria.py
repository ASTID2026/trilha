"""Normalização do Ro-DOU e motor determinístico das trilhas T01 a T09."""

from __future__ import annotations

import csv
import html
import io
import json
import re
import unicodedata
from datetime import datetime
from typing import Any, Iterable


DEFAULT_INTEREST_TERMS = [
    "internacional",
    "exterior",
    "notificação",
    "penalidade",
    "multa",
    "notificada",
    "intimação",
    "imposição",
    "inexigibilidade",
]

TRAIL_CATALOG = [
    {"id": "T01", "name": "Materialidade financeira", "category": "Risco financeiro", "description": "Prioriza adjudicações, contratos, credenciamentos e alterações com valores relevantes."},
    {"id": "T02", "name": "Múltiplos certames no mesmo processo", "category": "Planejamento", "description": "Relaciona licitações distintas vinculadas ao mesmo processo administrativo, objeto ou família de compras."},
    {"id": "T03", "name": "Alterações contratuais", "category": "Contratações", "description": "Monitora termos aditivos, apostilamentos, prorrogações, reajustes e alterações acumuladas."},
    {"id": "T04", "name": "Tempestividade da publicação", "category": "Transparência", "description": "Compara a assinatura do ato com a data de publicação no DOU e identifica intervalos relevantes."},
    {"id": "T05", "name": "Sanções, PAAI e intimações", "category": "Integridade", "description": "Acompanha penalidades, notificações, intimações, prazos de defesa e efeitos sobre fornecedores."},
    {"id": "T06", "name": "Rescisões e continuidade", "category": "Execução contratual", "description": "Sinaliza rescisões para exame das causas, impactos operacionais e medidas de continuidade."},
    {"id": "T07", "name": "Credenciamentos e cessões", "category": "Contratação excepcional", "description": "Seleciona credenciamentos, concessões, autorizações de uso e contratações diretas para validação específica."},
    {"id": "T08", "name": "Qualidade cadastral", "category": "Qualidade de dados", "description": "Identifica processos ausentes, formatos atípicos e campos essenciais não extraídos em atos formalizados."},
    {"id": "T09", "name": "Termos de interesse do CENCIAR", "category": "Monitoramento temático", "description": "Busca termos configuráveis no título e no resumo das publicações para acompanhamento específico."},
]


def fold(value: Any) -> str:
    text = unicodedata.normalize("NFD", str(value or "").lower())
    return " ".join("".join(ch for ch in text if unicodedata.category(ch) != "Mn").split())


def sanitize_interest_terms(value: Any) -> list[str]:
    if isinstance(value, str):
        candidates: Iterable[Any] = re.split(r"[;,\n]", value)
    elif isinstance(value, list):
        candidates = value
    else:
        candidates = []
    seen: set[str] = set()
    result: list[str] = []
    for candidate in candidates:
        if not isinstance(candidate, str):
            continue
        term = " ".join(candidate.strip().lower().split())[:60]
        key = fold(term)
        if len(key) < 2 or key in seen:
            continue
        seen.add(key)
        result.append(term)
        if len(result) == 50:
            break
    return result


def parse_interest_terms(value: Any) -> list[str]:
    if value in (None, ""):
        return list(DEFAULT_INTEREST_TERMS)
    if isinstance(value, str):
        try:
            parsed = json.loads(value)
            if isinstance(parsed, list):
                return sanitize_interest_terms(parsed)
        except (TypeError, ValueError):
            pass
    return sanitize_interest_terms(value)


def find_interest_terms(publication: dict[str, Any], terms: Iterable[str]) -> list[str]:
    text = fold(f"{publication.get('title', '')} {publication.get('summary', '')}")
    matched: list[str] = []
    for term in sanitize_interest_terms(list(terms)):
        pattern = re.escape(fold(term)).replace(r"\ ", r"\s+")
        if re.search(rf"(^|[^a-z0-9]){pattern}(?=$|[^a-z0-9])", text, re.I):
            matched.append(term)
    return matched


def severity_from(score: int) -> str:
    if score >= 85:
        return "Crítico"
    if score >= 70:
        return "Alto"
    if score >= 50:
        return "Médio"
    return "Baixo"


def brl(value: float | None) -> str:
    if value is None:
        return "—"
    formatted = f"{value:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return f"R$ {formatted}"


def decode_csv_bytes(data: bytes) -> str:
    try:
        text = data.decode("utf-8-sig")
        if text.count("�") <= 3:
            return text
    except UnicodeDecodeError:
        pass
    return data.decode("cp1252", errors="replace")


def parse_csv_bytes(data: bytes) -> list[dict[str, str]]:
    text = decode_csv_bytes(data)
    sample = text[:8192]
    try:
        dialect = csv.Sniffer().sniff(sample, delimiters=";,\t")
        delimiter = dialect.delimiter
    except csv.Error:
        first_line = text.splitlines()[0] if text.splitlines() else ""
        delimiter = max((";", ",", "\t"), key=first_line.count)
    reader = csv.DictReader(io.StringIO(text, newline=""), delimiter=delimiter)
    rows: list[dict[str, str]] = []
    for raw in reader:
        if not raw:
            continue
        row = {str(key or "").strip(): str(value or "").strip() for key, value in raw.items()}
        if any(row.values()):
            rows.append(row)
    return rows


def decode_summary(value: str) -> str:
    text = re.sub(r"<br\s*/?\s*>", " ", value or "", flags=re.I)
    text = re.sub(r"</p>", " ", text, flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return " ".join(html.unescape(text).split())


def extract_contract_parties(summary: str) -> dict[str, str]:
    text = decode_summary(summary).replace("**", "")
    field_pattern = re.compile(
        r"\b(contratante|contratad[oa]|objeto|fundamento legal|vigência|valor(?: total)?(?: atualizado do contrato| do termo aditivo)?|data de assinatura|data de abertura|n[º°]\s*processo|número do contrato|processo|signatários|dotação orçamentária|observações)\s*:",
        re.I,
    )
    fields = list(field_pattern.finditer(text))
    result = {"contractingParty": "", "contractedParty": ""}
    for index, match in enumerate(fields):
        label = fold(match.group(1))
        if label not in {"contratante", "contratado", "contratada"}:
            continue
        key = "contractingParty" if label == "contratante" else "contractedParty"
        end = fields[index + 1].start() if index + 1 < len(fields) else len(text)
        value = text[match.end():end]
        value = re.sub(r"\s*\(COMPRASNET[\s\S]*$", "", value, flags=re.I).strip()
        value = re.sub(r"[.;,]+$", "", value).strip()
        if re.search(r"\bS\.A$", value, flags=re.I):
            value += "."
        if value and not result[key]:
            result[key] = value
    return result


def first_match(text: str, pattern: str, group: int = 1, flags: int = re.I) -> str:
    match = re.search(pattern, text or "", flags)
    return re.sub(r"[.;]+$", "", match.group(group).strip()) if match else ""


def money_to_number(value: str) -> float:
    return float(value.replace(".", "").replace(",", "."))


def category_from_title(title: str) -> str:
    normalized = fold(title).upper()
    if "LICITACAO" in normalized:
        return "Licitação"
    if "ADITIVO" in normalized or "APOSTILAMENTO" in normalized:
        return "Alteração contratual"
    if "RESCISAO" in normalized:
        return "Rescisão"
    if any(word in normalized for word in ("PENALIDADE", "INTIMACAO", "NOTIFICA")):
        return "Integridade"
    if "CREDENCIAMENTO" in normalized:
        return "Credenciamento"
    if "CONTRATO" in normalized:
        return "Contrato"
    if "CONCESSAO" in normalized or "AUTORIZACAO DE USO" in normalized:
        return "Cessão de uso"
    if "ADJUDICACAO" in normalized or "HOMOLOGACAO" in normalized:
        return "Homologação"
    return "Outros atos"


def normalize_rows(raw_rows: list[dict[str, str]], import_id: str) -> list[dict[str, Any]]:
    publications: list[dict[str, Any]] = []
    for index, raw in enumerate(raw_rows, start=1):
        normalized = {fold(key): value for key, value in raw.items()}

        def get(*names: str) -> str:
            for name in names:
                if fold(name) in normalized:
                    return normalized[fold(name)]
            return ""

        summary = decode_summary(get("resumo", "texto", "conteudo"))
        parties = extract_contract_parties(summary)
        title = get("titulo", "tipo") or "PUBLICAÇÃO"
        procurement_code = first_match(summary, r"[?&]compra=(\d+)")
        uasg = first_match(f"{title} {summary}", r"UASG\s*(\d{6})") or (procurement_code[:6] if procurement_code else "")
        process = first_match(summary, r"(?:Número do processo|Nº Processo|N\.º Processo|Processo)\s*:\s*([\d.\/-]+)")
        if not process:
            process = first_match(summary, r"\b(\d{5}\.\d{6}/\d{4}-\d{2})\b")
        modality = first_match(summary, r"Modalidade\s*:\s*(.*?)\s*/\s*(?:Número do processo|Nº Processo)")
        if not modality:
            modality = first_match(summary, r"((?:Pregão|Concorrência|Inexigibilidade|Dispensa|Credenciamento)\.?\s*(?:Nº|N°)?\s*[\d/.-]+)")
        contract = first_match(title, r"CONTRATO Nº\s*([\w.-]+/\d{4})")
        if not contract:
            contract = first_match(summary, r"(?:Número do Contrato|Contrato)\s*:\s*(?:Nº\s*)?([\w.-]+/\d{4})")
        object_text = first_match(
            summary,
            r"Objeto\s*:\s*(.*?)(?=\s+(?:Fundamento Legal|Vigência|Valor Total|Data de Assinatura|Data de Abertura|Endereço eletrônico|Contratante|Contratado)\s*:|$)",
        )
        cnpjs = list(dict.fromkeys(re.findall(r"\d{2}\.\d{3}\.\d{3}[/.]\d{4}-\d{2}", summary)))
        values = [money_to_number(item) for item in re.findall(r"R\$\s*([\d.]+,\d{2})", summary, flags=re.I)]
        stated_total = first_match(summary, r"(?:preço global final|Valor Total(?: Atualizado do Contrato)?|valor total)\s*(?:de|:)\s*R\$\s*([\d.]+,\d{2})")
        validity = re.search(r"Vigência\s*:\s*(\d{2}/\d{2}/\d{4})\s*a\s*(\d{2}/\d{2}/\d{4})", summary, re.I)
        supplier = re.sub(r"^(?:\d{2}\.\d{3}\.\d{3}[/.]\d{4}-\d{2}|\d{14})\s*[-–—]?\s*", "", parties["contractedParty"])
        if not supplier:
            supplier = first_match(summary, r"licitante\s*:\s*(.+?)\s*\(CNPJ") or first_match(summary, r"A empresa\s+(.+?)(?:,|\s+inscrita no CNPJ)")
        organization = parties["contractingParty"] or get("unidade") or "Comando da Aeronáutica"
        publications.append({
            "id": f"{import_id}-pub-{index}",
            "importId": import_id,
            "searchTerm": get("termo de pesquisa"),
            "unit": get("unidade"),
            "section": get("secao"),
            "url": get("url", "link"),
            "title": title,
            "summary": summary,
            "date": get("data", "data publicacao", "data de publicacao"),
            "category": category_from_title(title),
            "uasg": uasg,
            "process": process,
            "modality": modality,
            "procurementCode": procurement_code,
            "contract": contract,
            "cnpj": cnpjs[0] if cnpjs else "",
            "cnpjs": cnpjs,
            "supplier": supplier,
            "organization": organization,
            **parties,
            "object": object_text or summary[:280],
            "value": money_to_number(stated_total) if stated_total else (max(values) if values else None),
            "values": values,
            "signatureDate": first_match(summary, r"Data de Assinatura\s*:\s*(\d{2}/\d{2}/\d{4})"),
            "validityStart": validity.group(1) if validity else "",
            "validityEnd": validity.group(2) if validity else "",
            "openingDate": first_match(summary, r"Data de Abertura\s*:\s*(\d{2}/\d{2}/\d{4})"),
            "legalBasis": first_match(summary, r"Fundamento Legal\s*:\s*(.*?)(?=\s+Vigência\s*:|\s+Valor Total|\s+Data de Assinatura|$)"),
        })
    return publications


def parse_br_date(value: str) -> datetime | None:
    try:
        return datetime.strptime(value, "%d/%m/%Y")
    except (TypeError, ValueError):
        return None


def days_between(start: str, end: str) -> int:
    first, second = parse_br_date(start), parse_br_date(end)
    return (second - first).days if first and second else 0


def make_interest_term_alerts(publications: list[dict[str, Any]], terms: Iterable[str]) -> list[dict[str, Any]]:
    priority = {fold(term) for term in ("notificação", "penalidade", "multa", "notificada", "intimação", "imposição")}
    alerts: list[dict[str, Any]] = []
    for publication in publications:
        matched = find_interest_terms(publication, terms)
        if not matched:
            continue
        score = 74 if any(fold(term) in priority for term in matched) else (70 if len(matched) >= 3 else 62)
        alerts.append({
            "id": f"T09-{publication['id']}",
            "publicationId": publication["id"],
            "trailId": "T09",
            "trail": "Termos de interesse do CENCIAR",
            "score": score,
            "severity": severity_from(score),
            "title": f"Termos de interesse · {', '.join(matched)}",
            "reason": "A publicação contém um ou mais termos definidos pelo CENCIAR para acompanhamento temático.",
            "evidence": [f"Termos localizados: {', '.join(matched)}", f"Ato: {publication['title']}", f"Processo: {publication['process'] or 'não extraído'}"],
            "procedure": ["Acessar a publicação e confirmar o contexto em que os termos foram utilizados.", "Avaliar a pertinência do ato para as competências e trabalhos do CENCIAR.", "Registrar a conclusão e, quando necessário, relacionar o ato a outras publicações ou processos."],
            "status": "Novo",
        })
    return alerts


def make_alerts(publications: list[dict[str, Any]], materiality: float = 500_000, publication_lag: int = 30, interest_terms: Iterable[str] = DEFAULT_INTEREST_TERMS) -> list[dict[str, Any]]:
    alerts: list[dict[str, Any]] = []
    contract_counts: dict[str, int] = {}
    bidding_counts: dict[str, int] = {}
    for row in publications:
        if row["contract"]:
            key = f"{row['uasg']}|{row['contract']}"
            contract_counts[key] = contract_counts.get(key, 0) + 1
        if row["process"] and row["category"] == "Licitação":
            bidding_counts[row["process"]] = bidding_counts.get(row["process"], 0) + 1

    def add(publication: dict[str, Any], trail_id: str, trail: str, score: int, title: str, reason: str, evidence: list[str], procedure: list[str]) -> None:
        alerts.append({"id": f"{trail_id}-{publication['id']}", "publicationId": publication["id"], "trailId": trail_id, "trail": trail, "score": score, "severity": severity_from(score), "title": title, "reason": reason, "evidence": evidence, "procedure": procedure, "status": "Novo"})

    for publication in publications:
        text = fold(f"{publication['title']} {publication['summary']}")
        value = publication["value"]
        if value is not None and value >= materiality:
            score = 97 if value >= 100_000_000 else 90 if value >= 10_000_000 else 82 if value >= 1_000_000 else 72
            add(publication, "T01", "Materialidade financeira", score, f"Materialidade {'crítica' if score >= 85 else 'alta'} · {brl(value)}", "O valor extraído do ato supera o limiar de priorização financeira definido para o monitoramento contínuo.", [f"Valor publicado: {brl(value)}", f"UASG: {publication['uasg'] or 'não extraída'}", f"Processo: {publication['process'] or 'não extraído'}"], ["Confirmar o valor e a natureza da despesa no instrumento original.", "Avaliar riscos de preço, orçamento, habilitação e execução conforme o tipo de ato.", "Relacionar a contratação a aditivos, empenhos e pagamentos em ciclos posteriores."])
        if publication["process"] and publication["category"] == "Licitação" and bidding_counts.get(publication["process"], 0) > 1:
            add(publication, "T02", "Múltiplos certames no mesmo processo", 88, f"Múltiplas licitações · Processo {publication['process']}", "O mesmo processo administrativo foi associado a mais de um aviso de licitação no lote, exigindo consolidação do objeto e da estratégia de contratação.", [f"Ocorrências no lote: {bidding_counts[publication['process']]}", f"Modalidade: {publication['modality'] or 'não extraída'}", f"Código da compra: {publication['procurementCode'] or 'não extraído'}"], ["Consolidar todos os avisos e itens vinculados ao processo.", "Verificar se há divisão justificável por lotes ou risco de fracionamento indevido.", "Comparar objetos, códigos de compra, datas de abertura e estimativas de valor."])
        if publication["category"] == "Alteração contratual":
            same_contract = contract_counts.get(f"{publication['uasg']}|{publication['contract']}", 0)
            score = 92 if re.search(r"25(?:,00)?%", text) else 78 if same_contract > 1 else 58
            add(publication, "T03", "Alterações contratuais", score, re.sub(r"\s*-\s*UASG.*$", "", publication["title"], flags=re.I), "O contrato possui mais de uma alteração publicada no lote, recomendando análise cumulativa." if same_contract > 1 else "Ato altera prazo, valor, equilíbrio econômico-financeiro ou condições do contrato.", [f"Contrato: {publication['contract'] or 'não extraído'}", f"Processo: {publication['process'] or 'não extraído'}", f"Valor atualizado: {brl(value)}"], ["Reconstruir a linha do tempo do contrato e de todas as alterações.", "Recalcular percentuais e impactos acumulados sobre prazo e valor.", "Examinar justificativas, pareceres e autorização da autoridade competente."])
        lag = days_between(publication["signatureDate"], publication["date"])
        if lag > publication_lag:
            add(publication, "T04", "Tempestividade da publicação", 86 if lag > 60 else 72, f"Publicação {lag} dias após a assinatura", f"O intervalo entre assinatura e publicação supera {publication_lag} dias e pode afetar transparência, eficácia ou controle tempestivo.", [f"Assinatura: {publication['signatureDate']}", f"Publicação: {publication['date']}", f"Intervalo: {lag} dias"], ["Confirmar a data de produção de efeitos do instrumento.", "Verificar a motivação para o intervalo e a tempestividade da publicidade.", "Avaliar atos de execução ocorridos antes da publicação."])
        if re.search(r"penalidade|edital de\s+notificacao|edital de intimacao|apuracao de irregularidade", text):
            sanction = bool(re.search(r"penalidade|impedimento de licitar|sancionad|multa aplicada", text))
            add(publication, "T05", "Sanções, PAAI e intimações", 92 if sanction else 78, f"Sanção ou penalidade · {publication['supplier'] or publication['cnpj'] or 'fornecedor identificado no ato'}" if sanction else "Processo sancionador em acompanhamento", "O ato registra penalidade, multa ou impedimento com possíveis reflexos sobre contratações vigentes e futuras." if sanction else "A publicação registra notificação ou intimação com prazo processual e necessidade de acompanhamento do desfecho.", [f"Processo: {publication['process'] or 'não extraído'}", f"CNPJ principal: {publication['cnpj'] or 'não extraído'}", f"Ato: {publication['title']}"], ["Registrar o marco processual e eventual prazo de defesa ou recurso.", "Confirmar o registro da sanção e seu alcance nos cadastros oficiais.", "Verificar contratações, empenhos ou pagamentos posteriores quando aplicável."])
        if publication["category"] == "Rescisão":
            add(publication, "T06", "Rescisões e continuidade", 82, f"Rescisão · Contrato {publication['contract'] or 'não extraído'}", "A rescisão pode indicar falha de execução, risco de descontinuidade ou necessidade de nova contratação.", [f"UASG: {publication['uasg'] or 'não extraída'}", f"Processo: {publication['process'] or 'não extraído'}", f"Fornecedor: {publication['supplier'] or publication['cnpj'] or 'não extraído'}"], ["Identificar a causa, natureza e efeitos financeiros da rescisão.", "Verificar sanções, garantias, saldos e providências de continuidade.", "Avaliar concentração de rescisões na mesma UASG e período."])
        if re.search(r"credenciamento|autorizacao de uso|concessao|inexigibilidade|dispensa", text):
            score = 82 if value is not None and value >= 1_000_000 else 58
            add(publication, "T07", "Credenciamentos e cessões", score, f"{publication['category']} · {'UASG ' + publication['uasg'] if publication['uasg'] else 'análise específica'}", "O ato utiliza regime de credenciamento, contratação direta, concessão ou autorização de uso e demanda testes próprios de conformidade.", [f"Modalidade: {publication['modality'] or publication['category']}", f"Valor: {brl(value)}", f"CNPJs citados: {len(publication['cnpjs'])}"], ["Validar hipótese legal, motivação e critérios de seleção.", "Examinar publicidade, isonomia e compatibilidade dos preços.", "Verificar obrigações, contrapartidas, limites e condições de vigência."])
        formalized = publication["category"] in {"Contrato", "Alteração contratual", "Rescisão"}
        compact_process = bool(publication["process"] and not re.search(r"[./-]", publication["process"]))
        if (formalized and not publication["process"]) or compact_process:
            add(publication, "T08", "Qualidade cadastral", 55, "Processo em formato não padronizado" if compact_process else "Processo não extraído do ato", "A identificação do processo está ausente ou em formato atípico, reduzindo a confiabilidade dos cruzamentos e da rastreabilidade.", [f"Título: {publication['title']}", f"Processo extraído: {publication['process'] or 'ausente'}", f"URL original preservada: {'sim' if publication['url'] else 'não'}"], ["Conferir o número no ato original e no sistema corporativo.", "Corrigir ou complementar o identificador antes de cruzamentos.", "Registrar a causa da falha de extração para calibrar o parser."])

    alerts.extend(make_interest_term_alerts(publications, interest_terms))
    return sorted(alerts, key=lambda alert: alert["score"], reverse=True)
