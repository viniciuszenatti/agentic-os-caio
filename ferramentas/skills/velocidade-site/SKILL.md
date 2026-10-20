---
name: velocidade-site
description: Mede a velocidade de um site público com a PageSpeed Insights API v5 (curl/node, sem MCP) — nota mobile e desktop, Core Web Vitals de usuários reais (CrUX) × laboratório (Lighthouse) e as maiores oportunidades com economia estimada; unlighthouse para varrer o site inteiro. Use quando pedirem "testa a velocidade do site", "pagespeed", "core web vitals", "o site está lento?", "lighthouse", "nota do Google", "LCP/INP/CLS do site", ou antes/depois de mexer em performance de uma página pública (ex.: https://www.exemplo.com).
---

# Velocidade de site

Regra do time: **medir antes de opinar** e nunca relatar melhora sem o número de antes e o de
depois, medidos do mesmo jeito (mesma estratégia, mesma URL).

## 1. Medir uma ou mais páginas (padrão)

```bash
node ~/.claude/skills/velocidade-site/psi.mjs https://www.exemplo.com                 # mobile + desktop
node ~/.claude/skills/velocidade-site/psi.mjs https://www.exemplo.com --estrategia mobile
node ~/.claude/skills/velocidade-site/psi.mjs https://a.com https://a.com/precos   # várias URLs
```

- Imprime resumo em pt-BR: nota 0–100, campo (página e domínio), laboratório e top 5 oportunidades.
- JSON bruto vai para `~/.claude/deck/velocidade/<AAAA-MM-DD-HHMM>-<host>-<estrategia>.json`
  (`--saida <dir>` muda). Use o JSON para detalhe (`lighthouseResult.audits.<id>.details`).
- Cada chamada leva 15–60 s (o Google roda o Lighthouse do lado de lá).
- Código de saída: `0` ok · `1` alguma medição falhou · `2` uso errado · `3` cota (429).
- Só funciona com URL **pública**. DEV/localhost/página com login → use o MCP chrome-devtools (seção 4).

**Sempre rode mobile e desktop.** O Google ranqueia pela versão mobile; desktop quase sempre
tira nota maior e esconde o problema.

## 2. Ler o resultado: campo × laboratório

| | Campo (CrUX) | Laboratório (Lighthouse) |
|---|---|---|
| O que é | p75 de usuários reais do Chrome, últimos 28 dias | 1 carga simulada (Moto G lento + 4G no mobile) |
| Vale para | **decidir se há problema** e o que priorizar | **diagnosticar a causa** e comparar antes/depois |
| Muda quando | só depois de semanas de visitas novas | na hora |

Limiares (p75) — Core Web Vitals:

| Métrica | Bom | Precisa melhorar | Ruim |
|---|---|---|---|
| **LCP** (carregamento) | ≤ 2,5 s | 2,5–4 s | > 4 s |
| **INP** (resposta ao toque) | ≤ 200 ms | 200–500 ms | > 500 ms |
| **CLS** (estabilidade visual) | ≤ 0,1 | 0,1–0,25 | > 0,25 |
| FCP (diagnóstico) | ≤ 1,8 s | 1,8–3 s | > 3 s |
| TTFB (diagnóstico) | ≤ 0,8 s | 0,8–1,8 s | > 1,8 s |

Como interpretar sem errar:
- **"Sem dado de campo"** = site com pouco tráfego no CrUX (comum em landing nova). Aí só
  existe laboratório; diga isso no laudo, não invente nota de usuário real.
- **Campo bom + laboratório ruim** → usuários reais estão bem (aparelho/rede melhores que a
  simulação). Prioridade baixa, a menos que o público seja celular fraco.
- **Campo ruim + laboratório bom** → problema que a carga simulada não pega: INP (interação),
  CLS tardio, terceiros (chat, pixel), rotas internas. Investigue com trace (seção 4).
- **INP não existe no laboratório.** TBT é só um indício. INP só vem do campo.
- Nota do laboratório oscila ±5–10 pontos entre execuções. Diferença menor que isso não é melhora.
  Para comparar, rode 3 vezes e use a mediana.
- "Página" usa a URL exata; "Domínio inteiro" é a média do site. Se a página não tem dado, o script
  mostra só o domínio.

Oportunidades: a economia (`~1,2 s`, `~469 KB`) é **estimativa do Lighthouse** sobre o laboratório,
não ganho garantido no campo. Ordene a correção por economia em LCP primeiro.

## 3. Varrer o site inteiro (unlighthouse, local e grátis)

```bash
npx --yes -p @unlighthouse/cli unlighthouse-ci --site https://www.exemplo.com \
  --mobile --reporter jsonExpanded --output-path ~/.claude/deck/velocidade/unlighthouse-$(date +%F)
```

Flags úteis (conferidas em unlighthouse.dev/integrations/ci, v0.19.1):
`--urls /,/precos` (só essas, sem crawler) · `--exclude-urls /blog/**` · `--samples 3` ·
`--budget 75` (exit 1 se alguma página ficar abaixo) · `--desktop` · `--throttle` ·
`--reporter json|jsonExpanded|csv|csvExpanded`.

Cuidados em máquina modesta (notebook, 16 GB): roda um Chrome por página e pesa. O primeiro `npx` baixa
o pacote (minutos). Comece com `--urls` de 3–5 rotas antes de soltar o crawler no site inteiro.
Nota do unlighthouse **não** é comparável com a do PSI (máquina e rede diferentes): compare
unlighthouse com unlighthouse.

## 4. Trace detalhado (quando o PSI não basta)

Se o MCP `chrome-devtools` estiver disponível: `navigate_page` → `performance_start_trace`
(com reload) → `performance_stop_trace` → `performance_analyze_insight` no insight ligado à métrica
ruim (LCPBreakdown, RenderBlocking, DocumentLatency, CLSCulprits, ThirdParties…). Serve para
DEV, localhost e páginas com login. Ver também as skills `performance` e `core-web-vitals`
(Addy Osmani) — elas recomendam trace em vez de `lighthouse_audit` para performance.

## 5. Como gerar a chave grátis

Sem chave, a API usa uma cota anônima **compartilhada** por todo mundo; em 20/10/2026 ela já
estava esgotada (`429 Quota exceeded ... 'Queries per day'`). Com chave própria a cota é sua.

1. Abra https://console.cloud.google.com/ e crie (ou escolha) um projeto.
2. **APIs e serviços → Biblioteca** → procure **PageSpeed Insights API** → **Ativar**.
3. **APIs e serviços → Credenciais → Criar credenciais → Chave de API**.
4. (Recomendado) Edite a chave → **Restrições de API** → só "PageSpeed Insights API".
5. Salve:
   ```bash
   mkdir -p ~/.config/psi && printf 'PSI_API_KEY=%s\n' 'COLE_A_CHAVE' > ~/.config/psi/.env && chmod 600 ~/.config/psi/.env
   ```
6. Teste: `node ~/.claude/skills/velocidade-site/psi.mjs https://web.dev --estrategia mobile`
   — a primeira linha deve dizer "com chave".

**Faturamento — o que foi e o que não foi confirmado:** a doc oficial
(developers.google.com/speed/docs/insights/v5/get-started) diz só que a API funciona "com ou sem
chave, mas a chave é recomendada para consultas automatizadas e frequentes". **Ela não fala de
preço, cota nem faturamento** (conferido em 20/10/2026 nessa página, na FAQ e na referência
`runPagespeed`). A informação corrente na comunidade é que a API é gratuita e não exige conta de
faturamento, mas isso **não está confirmado na doc oficial**. Se o Console pedir cartão ou
faturamento em qualquer passo, **pare**: é decisão de custo e precisa do aval do usuário.

A chave é segura em URL (a própria doc diz), mas não commite `~/.config/psi/.env` em repositório.
