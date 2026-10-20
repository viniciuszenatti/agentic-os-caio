CREATE TABLE pedidos (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  status text NOT NULL,
  criado_em timestamptz NOT NULL
);
CREATE INDEX idx_pedidos_tenant ON pedidos (tenant_id, criado_em DESC);
CREATE TABLE clientes (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  apelido text
);
CREATE TABLE cobrancas (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  conversa_id integer,
  status text NOT NULL,
  criado_em timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_cobrancas_pendentes
  ON cobrancas (tenant_id, conversa_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS ix_clientes_vivos ON clientes (id) WHERE apelido IS NOT NULL;
