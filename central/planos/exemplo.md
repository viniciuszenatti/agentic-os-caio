# Login do app mais rápido — plano de exemplo

Plano de exemplo no formato da Central (docs/arquitetura.md). É o formato do escritório com quatro chaves
novas: `papel`, `area`, `onde` e `esforco`. O que o bloco não diz vem do papel no `papeis.json`.

## Mapa de execução

| Item | Onde roda | O que faz | Depois de | Não junto com |
|---|---|---|---|---|
| **P1** | local | mede o login hoje e acha o gargalo | — | — |
| **P2** | local | corrige a rota do BFF | P1 | P3 |
| **P3** | nuvem | ajusta a tela de login | P1 | P2 |
| **P4** | projects | revisão de acessibilidade da tela | P3 | — |
| **P5** | local | prova na tela e fecha a tarefa | P2, P4 | — |

## P1 — Medir o login de hoje

```prompt id=P1 repo=~/Projects/meu-app papel=rapido area=web onde=local custo=zero
Meça o tempo do login no DEV (do clique em Entrar até a tela inicial) em 5 tentativas e
descubra qual chamada consome mais tempo. Não altere código. Ao terminar, escreva o resultado
em docs/medicoes/login.md com a tabela das 5 tentativas.
```

## P2 — Corrigir a rota lenta do BFF

```prompt id=P2 repo=~/Projects/meu-app papel=executor area=web depende=P1 conflita=P3 exclusivo=repo porta="merge na main"
Leia docs/medicoes/login.md e corrija a chamada mais lenta apontada lá. Trabalhe na branch
plano/P2, rode `pnpm test` e abra o PR. O merge na main é decisão de um humano.
```

## P3 — Ajustar a tela de login

```prompt id=P3 repo=~/Projects/meu-app papel=executor area=web onde=nuvem esforco=high depende=P1
Mostre um indicador de carregamento no botão Entrar enquanto a sessão abre, sem trocar o
layout. Commit e push na branch plano/P3.
```

## P4 — Revisão de acessibilidade

```prompt id=P4 repo=~/Projects/meu-app papel=verificador area=design onde=projects depende=P3
Revise a tela de login da branch plano/P3 contra WCAG 2.2 AA (contraste, foco, leitor de tela).
Só leitura: devolva a lista de problemas com seletor e correção sugerida.
```

## P5 — Prova na tela e fechamento

```prompt id=P5 repo=~/Projects/meu-app papel=executor area=qa depende=P2,P4 modelo=claude-opus-5-5
Confira no DEV que o login ficou mais rápido que a medição de docs/medicoes/login.md e que
os problemas da revisão de acessibilidade foram tratados. Escreva o antes × depois.
```
