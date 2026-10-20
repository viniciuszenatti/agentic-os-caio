import { pool } from "./pool";

const WHERE_DO_TENANT = `
  WHERE tenant_id = $1
    AND status = 'aberto'`;

export async function sumidos(tenantId: string, filtro: string) {
  // NÃO conta: o WHERE vem de constante do módulo (tenant_id tem índice)
  await pool.query(`SELECT id FROM pedidos ${WHERE_DO_TENANT} ORDER BY criado_em DESC`, [tenantId]);
  // NÃO conta: interpolação desconhecida depois do FROM — não dá para julgar
  await pool.query(`SELECT id FROM clientes ${filtro}`);
  // NÃO conta: índice parcial cobre status = 'pending'
  return pool.query(`SELECT id FROM cobrancas WHERE status = 'pending' AND criado_em < now() ORDER BY criado_em LIMIT 50`);
}

export async function porGateway(id: string) {
  // CONTA: valor interpolado não cega a análise; email não tem índice
  return pool.query(`SELECT id FROM clientes WHERE email = ${id} LIMIT 1`);
}

export async function vivos() {
  // CONTA: índice parcial com IS NOT NULL não é seletivo
  return pool.query(`SELECT id FROM clientes WHERE apelido IS NOT NULL ORDER BY email LIMIT 20`);
}
