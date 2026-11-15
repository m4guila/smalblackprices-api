"""
SmalBlackPrices Bot — posta ofertas com link de afiliado num canal do Telegram.

Fluxo: busca ofertas na API do SmalBlackPrices -> confere histórico de preço ->
gera link de afiliado -> pede um texto à IA -> envia foto + legenda ao canal.
"""
import html
import json
import os
import random
import sys
import time
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import requests
from dotenv import load_dotenv

load_dotenv()


def env(name, default=""):
    return (os.getenv(name) or default).strip()


TELEGRAM_TOKEN = env("TELEGRAM_TOKEN")
CHANNEL_ID = env("CHANNEL_ID", "@SmalBlackPricesOfertas")
AMAZON_TAG = env("AMAZON_TAG", "matheussou0db-20")
ML_MATT_WORD = env("ML_MATT_WORD")
ML_MATT_TOOL = env("ML_MATT_TOOL")
BACKEND_URL = env("BACKEND_URL", "https://smalblackprices-api.onrender.com").rstrip("/")
SEARCH_TERMS = [t.strip() for t in env("SEARCH_TERMS").split(",") if t.strip()]
OPENROUTER_API_KEY = env("OPENROUTER_API_KEY")
OPENROUTER_MODEL = env("OPENROUTER_MODEL", "deepseek/deepseek-chat")
MAX_POSTS_PER_RUN = int(env("MAX_POSTS_PER_RUN", "5"))
POST_DELAY = int(env("POST_DELAY", "20"))
REPOST_AFTER_DAYS = int(env("REPOST_AFTER_DAYS", "3"))
ALLOW_UNVERIFIED = env("ALLOW_UNVERIFIED", "true").lower() == "true"
DRY_RUN = env("DRY_RUN", "true").lower() == "true"

POSTED_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "posted.json")
HTTP = requests.Session()
HTTP.headers["User-Agent"] = "SmalBlackPricesBot/1.0"


def log(msg):
    print(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------------------------------------------------------------- links de afiliado

def gerar_link_amazon(asin):
    """Link de afiliado Amazon a partir do ASIN (ex: B0GVP7Q8TX)."""
    return f"https://www.amazon.com.br/dp/{asin}?tag={AMAZON_TAG}"


def asin_da_url(url):
    """Extrai o ASIN de URLs /dp/XXXX ou /gp/product/XXXX."""
    partes = urlparse(url).path.split("/")
    for marcador in ("dp", "product"):
        if marcador in partes:
            i = partes.index(marcador)
            if i + 1 < len(partes) and len(partes[i + 1]) == 10:
                return partes[i + 1]
    return None


def gerar_link_mercadolivre(url_produto):
    """
    Mercado Livre não tem API pública para links de afiliado.
    - Se já for um link de afiliado (meli.la ou com matt_tool), usa como está.
    - Se ML_MATT_WORD e ML_MATT_TOOL estiverem configurados, adiciona esses
      parâmetros (os mesmos que aparecem num link gerado no seu painel).
    - Sem isso, retorna None e o produto é pulado (link sem rastreio = sem comissão).
    """
    if not url_produto:
        return None
    if "meli.la" in url_produto or "matt_tool=" in url_produto:
        return url_produto
    if not (ML_MATT_WORD and ML_MATT_TOOL):
        return None
    p = urlparse(url_produto)
    query = dict(parse_qsl(p.query))
    query.update({"matt_word": ML_MATT_WORD, "matt_tool": ML_MATT_TOOL})
    # remove o "#..." (ancora) que o ML coloca, pois às vezes quebra o rastreio
    return urlunparse(p._replace(query=urlencode(query), fragment=""))


def gerar_link_afiliado(produto):
    url = produto.get("url") or ""
    host = urlparse(url).netloc.lower()
    if "amazon." in host:
        asin = asin_da_url(url) or produto.get("id")
        return gerar_link_amazon(asin) if asin else None
    if "mercadolivre" in host or "mercadolibre" in host or "meli.la" in host:
        return gerar_link_mercadolivre(url)
    return None


# ---------------------------------------------------------------- fonte das ofertas

def chamar_api(rota, payload, tentativas=3):
    """O Render (plano grátis) 'dorme'; a 1ª chamada pode levar ~1 min."""
    for n in range(1, tentativas + 1):
        try:
            r = HTTP.post(f"{BACKEND_URL}{rota}", json=payload, timeout=90)
            if r.ok:
                return r.json()
            log(f"API {rota} respondeu {r.status_code} (tentativa {n})")
        except requests.RequestException as e:
            log(f"API {rota} falhou: {e} (tentativa {n})")
        time.sleep(10 * n)
    return {}


def buscar_ofertas():
    produtos = list(chamar_api("/api/trending", {}).get("results", []))
    for termo in SEARCH_TERMS:
        produtos += chamar_api("/api/search", {"query": termo}).get("results", [])
    unicos = {}
    for p in produtos:
        if p.get("id") and p.get("price"):
            unicos.setdefault(str(p["id"]), p)
    log(f"{len(unicos)} produtos únicos encontrados")
    return list(unicos.values())


def avaliar_preco(produto):
    """
    Retorna (eh_oferta, motivo). Usa o desconto da loja e/ou o histórico da sua API.
    """
    preco = float(produto["price"])
    antigo = produto.get("originalPrice")
    if antigo and float(antigo) > preco * 1.05:
        pct = round((1 - preco / float(antigo)) * 100)
        return True, f"{pct}% de desconto"

    dados = chamar_api("/api/history", {"product_id": produto["id"]}, tentativas=1)
    dados = dados.get("data", dados) or {}
    pontos = dados.get("points") or []
    if len(pontos) >= 2:
        precos = [float(pt["price"]) for pt in pontos if pt.get("price")]
        minimo = dados.get("min") or min(precos)
        tipico = dados.get("median") or sorted(precos)[len(precos) // 2]
        if preco <= float(minimo) * 1.01:
            return True, "menor preço que já monitoramos"
        if preco < float(tipico):
            return True, "abaixo do preço típico"
        return False, "preço acima do típico"

    return ALLOW_UNVERIFIED, "sem histórico suficiente"


# ---------------------------------------------------------------- texto com IA

TEXTOS_PRONTOS = [
    "Achado do dia! Corre que preço bom assim não dura muito. 🏃‍♂️",
    "Olha esse preço! Se estava esperando o momento certo, é agora. 👀",
    "Oferta garimpada pra você. Confere antes que acabe! 🔥",
    "Daqueles achados que dá vontade de mandar pro grupo da família. 😄",
]


def gerar_texto_ia(produto, motivo):
    if not OPENROUTER_API_KEY:
        return random.choice(TEXTOS_PRONTOS)
    prompt = (
        "Escreva UMA frase curta (máx. 25 palavras), em português do Brasil, "
        "animada e persuasiva, para divulgar este produto num canal de ofertas "
        "do Telegram. Use 1 ou 2 emojis. Não invente desconto, frete, estoque ou "
        "características que não estão abaixo. Responda só com a frase.\n\n"
        f"Produto: {produto['title']}\n"
        f"Preço: R$ {float(produto['price']):.2f}\n"
        f"Situação do preço: {motivo}"
    )
    try:
        r = HTTP.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={"Authorization": f"Bearer {OPENROUTER_API_KEY}"},
            json={
                "model": OPENROUTER_MODEL,
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 80,
                "temperature": 0.9,
            },
            timeout=40,
        )
        r.raise_for_status()
        texto = r.json()["choices"][0]["message"]["content"].strip().strip('"')
        return texto[:300] if texto else random.choice(TEXTOS_PRONTOS)
    except Exception as e:  # IA fora do ar não pode parar o bot
        log(f"IA falhou ({e}); usando texto pronto")
        return random.choice(TEXTOS_PRONTOS)


# ---------------------------------------------------------------- telegram

def brl(valor):
    s = f"{float(valor):,.2f}"
    return "R$ " + s.replace(",", "X").replace(".", ",").replace("X", ".")


def montar_legenda(produto, link, texto_ia, motivo):
    e = html.escape
    titulo = produto["title"]
    if len(titulo) > 150:
        titulo = titulo[:147] + "..."
    linhas = [f"🔥 <b>{e(titulo)}</b>", "", e(texto_ia), ""]
    antigo = produto.get("originalPrice")
    if antigo and float(antigo) > float(produto["price"]):
        linhas.append(f"❌ De: <s>{brl(antigo)}</s>")
    linhas.append(f"✅ Por: <b>{brl(produto['price'])}</b>")
    if motivo and motivo != "sem histórico suficiente":
        linhas.append(f"📉 {e(motivo.capitalize())}")
    linhas += [
        "",
        f"🛒 <a href=\"{e(link)}\">COMPRAR AGORA</a>",
        "",
        f"<i>🏬 {e(produto.get('store') or 'Loja')} · Preço pode mudar a qualquer momento.</i>",
    ]
    return "\n".join(linhas)[:1024]  # limite de legenda do Telegram


def enviar_telegram(produto, legenda):
    base = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}"
    if produto.get("image"):
        r = HTTP.post(f"{base}/sendPhoto", data={
            "chat_id": CHANNEL_ID, "photo": produto["image"],
            "caption": legenda, "parse_mode": "HTML",
        }, timeout=30)
        if r.ok:
            return True
        log(f"sendPhoto falhou ({r.text[:200]}); tentando só texto")
    r = HTTP.post(f"{base}/sendMessage", data={
        "chat_id": CHANNEL_ID, "text": legenda, "parse_mode": "HTML",
    }, timeout=30)
    if not r.ok:
        log(f"sendMessage falhou: {r.text[:300]}")
    return r.ok


# ---------------------------------------------------------------- controle de repetidos

def carregar_postados():
    try:
        with open(POSTED_FILE, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def salvar_postados(postados):
    limite = datetime.now(timezone.utc) - timedelta(days=30)
    postados = {k: v for k, v in postados.items()
                if datetime.fromisoformat(v["quando"]) > limite}
    with open(POSTED_FILE, "w", encoding="utf-8") as f:
        json.dump(postados, f, ensure_ascii=False, indent=1)


def ja_postado(postados, produto):
    reg = postados.get(str(produto["id"]))
    if not reg:
        return False
    recente = datetime.fromisoformat(reg["quando"]) > datetime.now(timezone.utc) - timedelta(days=REPOST_AFTER_DAYS)
    baixou = float(produto["price"]) < float(reg["preco"]) * 0.97  # caiu 3%+ -> pode repostar
    return recente and not baixou


# ---------------------------------------------------------------- principal

def main():
    if not DRY_RUN and not TELEGRAM_TOKEN:
        sys.exit("ERRO: TELEGRAM_TOKEN não configurado.")
    log(f"Iniciando ({'TESTE - nada será enviado' if DRY_RUN else 'PRODUÇÃO'}) -> {CHANNEL_ID}")

    postados = carregar_postados()
    produtos = buscar_ofertas()
    random.shuffle(produtos)
    enviados = 0

    for produto in produtos:
        if enviados >= MAX_POSTS_PER_RUN:
            break
        nome = produto["title"][:60]
        if ja_postado(postados, produto):
            continue
        link = gerar_link_afiliado(produto)
        if not link:
            log(f"Pulei (sem link de afiliado): {nome}")
            continue
        eh_oferta, motivo = avaliar_preco(produto)
        if not eh_oferta:
            log(f"Pulei ({motivo}): {nome}")
            continue

        legenda = montar_legenda(produto, link, gerar_texto_ia(produto, motivo), motivo)
        if DRY_RUN:
            print("\n" + "=" * 50 + f"\n[FOTO] {produto.get('image')}\n{legenda}\n" + "=" * 50)
            ok = True
        else:
            ok = enviar_telegram(produto, legenda)
        if ok:
            enviados += 1
            postados[str(produto["id"])] = {
                "quando": datetime.now(timezone.utc).isoformat(),
                "preco": float(produto["price"]),
                "titulo": produto["title"][:80],
            }
            log(f"✅ {'(teste) ' if DRY_RUN else ''}Postado: {nome}")
            if not DRY_RUN and enviados < MAX_POSTS_PER_RUN:
                time.sleep(POST_DELAY)

    if not DRY_RUN:
        salvar_postados(postados)
    log(f"Fim. {enviados} oferta(s) {'simuladas' if DRY_RUN else 'enviadas'}.")


if __name__ == "__main__":
    main()
