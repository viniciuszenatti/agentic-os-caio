LIMITE_PADRAO = {}  # NÃO conta: CAIXA ALTA é constante
_cache: dict[str, int] = {}  # PLANTADO estado


async def carregar(conn, ids):
    for i in ids:
        # PLANTADO n+1 (python)
        await conn.fetchrow("SELECT id FROM pedidos WHERE id = $1", i)
    return await conn.fetch(
        "SELECT id FROM pedidos "
        "WHERE tenant_id = $1 LIMIT 10"  # NÃO conta: SQL partido em duas strings
    )
