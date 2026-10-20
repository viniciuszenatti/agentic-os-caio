# Agentic OS: regras para quem trabalha neste repo

Leia `docs/arquitetura.md` antes de mexer.

## Regras
1. **Node 22, sem dependências npm.** Só módulos nativos (`node:fs`, `node:child_process`, `node:test`, `node:assert`), ES modules `.mjs`.
2. **Testes:** `npm test` (`node --test 'test/**/*.test.mjs'`) precisa passar. Módulo novo traz o seu `test/<modulo>.test.mjs`. O mod tem testes próprios: `claude plugin test mod`.
3. **Nada de shell com texto do usuário.** Tudo que vira processo é argv validado (`spawn(cmd, args)`), nunca `exec` de string.
4. **Injeção para o mundo externo.** Processo, arquivo do usuário e relógio entram por parâmetro (`{ spawn, fs, agora }`); os testes usam dublês (`test/stubs/`). Os testes nunca leem o `~/.claude` de verdade.
5. **Textos de interface em pt-BR**, com acentos.
6. **Disparar sessão é decisão humana.** Nada no código aprova plano sozinho; o disparo automático só vale dentro de plano já aprovado na Central.
