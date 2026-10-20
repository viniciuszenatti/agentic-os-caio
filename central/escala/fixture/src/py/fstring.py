_WHERE = "WHERE tenant_id = $1"


async def listar(conn, tenant_id):
    # NÃO conta: f-string com constante do módulo
    return await conn.fetch(f"SELECT id FROM pedidos {_WHERE} ORDER BY criado_em DESC", tenant_id)
