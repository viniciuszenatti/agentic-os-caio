# Instalador do Agentic OS para Windows (PowerShell 5.1 ou 7). Só COPIA arquivos; nunca apaga nada.
# - Arquivo igual no destino: pula (rodar de novo não muda nada).
# - Arquivo diferente no destino: o antigo vira <arquivo>.bak-AAAAMMDD-HHMMSS antes da cópia.
# - Não registra MCP, não instala o mod, não cria tarefa agendada, não sobe serviço: imprime os comandos no fim.
# - As units do systemd não vêm (não existem no Windows); veja o Agendador de Tarefas no README.
#
# Uso: powershell -ExecutionPolicy Bypass -File install.ps1 [-DryRun] [-SemFerramentas] [-Casa <pasta>]
#   -Casa troca a pasta do usuário (padrão: $HOME, isto é, %USERPROFILE%); serve para testar numa pasta vazia.
param(
  [switch]$DryRun,
  [switch]$SemFerramentas,
  [string]$Casa = $HOME
)
$ErrorActionPreference = 'Stop'

$Aqui = Split-Path -Parent $MyInvocation.MyCommand.Path
if ($env:AGENTIC_OS_DIR) { $Destino = $env:AGENTIC_OS_DIR } else { $Destino = Join-Path $Casa '.claude\agentic-os' }
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$script:copiados = 0; $script:iguais = 0; $script:backups = 0

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Write-Error 'precisa do node 22+ no PATH'; exit 1 }
$maior = [int](& node -p 'process.versions.node.split(".")[0]')
if ($maior -lt 22) { Write-Error "node $maior encontrado; precisa do 22+"; exit 1 }

function Copia([string]$o, [string]$d) {
  if (Test-Path -LiteralPath $d) {
    if ((Get-FileHash -LiteralPath $o).Hash -eq (Get-FileHash -LiteralPath $d).Hash) { $script:iguais++; return }
    Write-Host "backup: $d -> $d.bak-$Stamp"
    if (-not $DryRun) { Move-Item -LiteralPath $d -Destination "$d.bak-$Stamp" }
    $script:backups++
  }
  Write-Host "copia:  $d"
  if (-not $DryRun) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $d) | Out-Null
    Copy-Item -LiteralPath $o -Destination $d
  }
  $script:copiados++
}

function CopiaPasta([string]$o, [string]$d) {
  if (-not (Test-Path -LiteralPath $o -PathType Container)) { return }
  $base = (Resolve-Path -LiteralPath $o).Path.TrimEnd('\', '/')
  Get-ChildItem -LiteralPath $o -Recurse -File -Force | Where-Object { $_.FullName -notmatch '[\\/]\.git[\\/]' } | ForEach-Object {
    $rel = $_.FullName.Substring($base.Length).TrimStart('\', '/')
    Copia $_.FullName (Join-Path $d $rel)
  }
}

Write-Host "== 1/3 repo -> $Destino"
$mesmo = $false
if (Test-Path -LiteralPath $Destino) { $mesmo = ((Resolve-Path -LiteralPath $Aqui).Path -eq (Resolve-Path -LiteralPath $Destino).Path) }
if ($mesmo) {
  Write-Host '(rodando de dentro do destino: nada a copiar)'
} else {
  foreach ($item in @('central', 'cerebro', 'mod', 'rotinas', 'agentes', 'docs', 'test', 'coletar.mjs', 'package.json', 'CLAUDE.md', 'README.md', 'install.sh', 'install.ps1', '.gitignore', '.gitattributes')) {
    $o = Join-Path $Aqui $item
    if (Test-Path -LiteralPath $o -PathType Container) { CopiaPasta $o (Join-Path $Destino $item) }
    elseif (Test-Path -LiteralPath $o -PathType Leaf) { Copia $o (Join-Path $Destino $item) }
  }
}

Write-Host '== 2/3 agentes -> ~\.claude\agents'
Get-ChildItem -LiteralPath (Join-Path $Aqui 'agentes') -Filter '*.md' -File | ForEach-Object {
  Copia $_.FullName (Join-Path $Casa ".claude\agents\$($_.Name)")
}

if (-not $SemFerramentas) {
  Write-Host '== 3/3 ferramentas'
  $F = Join-Path $Aqui 'ferramentas'
  CopiaPasta (Join-Path $F 'skills') (Join-Path $Casa '.claude\skills')
  CopiaPasta (Join-Path $F 'agents') (Join-Path $Casa '.claude\agents')
  CopiaPasta (Join-Path $F 'rotinas') (Join-Path $Casa '.claude\rotinas')
  CopiaPasta (Join-Path $F 'limpeza') (Join-Path $Casa '.claude\limpeza')
  CopiaPasta (Join-Path $F 'mcp-cerebro') (Join-Path $Casa '.local\share\mcp-servers\cerebro')
  Write-Host '(units do systemd puladas: não existem no Windows)'
} else {
  Write-Host '== 3/3 ferramentas: pulado (-SemFerramentas)'
}

$seco = ''
if ($DryRun) { $seco = ' · DRY-RUN, nada foi escrito' }
Write-Host ''
Write-Host "Placar: $script:copiados copiados · $script:iguais iguais (pulados) · $script:backups backups .bak-$Stamp$seco"
$mcp = Join-Path $Casa '.local\share\mcp-servers\cerebro\server.mjs'
Write-Host @"

Próximos passos (nada disso foi feito pelo instalador):
  1. Testes:            cd "$Destino"; npm test
  2. Subir a Central:   node "$Destino\central\server.mjs"    # abre http://127.0.0.1:4747
  3. Índice do cérebro: node "$Destino\cerebro\indexar.mjs"
  4. MCP do cérebro:    claude mcp add --scope user cerebro -- node "$mcp"
  5. Mod do painel:     claude plugin marketplace add "$Destino\mod"; claude plugin install painel-escritorio@agentic-os
  6. Subir sozinho no login (opcional): ver "Windows: Agendador de Tarefas" no README.
"@
