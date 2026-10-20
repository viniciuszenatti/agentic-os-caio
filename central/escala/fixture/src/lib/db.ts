import { pool } from "./pool";
import { anthropic } from "./llm";

// PLANTADO estado: cache na memória do processo
const cachePorTenant = new Map<string, number>();
// NÃO conta: constante
const STATUS_VALIDOS = new Set(["aberto", "fechado"]);
const TIPOS = new Set(
  ["a", "b"],
);

export async function listarTodos() {
  // PLANTADO sem-limit
  return pool.query(`SELECT id, status FROM pedidos`);
}

export async function porTenant(tenantId: string) {
  // NÃO conta: filtro por coluna indexada + LIMIT
  return pool.query(`SELECT id FROM pedidos WHERE tenant_id = $1 ORDER BY criado_em DESC LIMIT 50`, [tenantId]);
}

export async function porEmail(email: string) {
  // PLANTADO sem-indice: email não tem índice
  return pool.query(`SELECT id FROM clientes WHERE email = $1`, [email]);
}

export async function detalhar(ids: string[]) {
  const out = [];
  for (const id of ids) {
    // PLANTADO n+1
    const r = await pool.query(`SELECT id FROM pedidos WHERE id = $1`, [id]);
    out.push(r);
  }
  return out;
}

export async function resumir(textos: string[]) {
  for (const t of textos) {
    // PLANTADO llm-em-laco (com teto, então não conta sem-teto)
    await anthropic.messages.create({ model: "claude-haiku-5-5", max_tokens: 200, messages: [{ role: "user", content: t }] });
  }
  // PLANTADO llm-sem-teto
  return anthropic.messages.create({
    model: "claude-haiku-5-5",
    messages: [{ role: "user", content: "oi" }],
  });
}
