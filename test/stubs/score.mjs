// Dublê de central/score/score.mjs (contrato C4).
export const PESOS_PADRAO = { seguranca: 20, bugs: 20, velocidade: 15, apis: 15, testes: 15, fluxo: 10, ambientes: 5 };
export function validarPesos(obj) {
  const soma = Object.values(obj).reduce((a, b) => a + Number(b), 0);
  return soma === 100 ? [] : [`a soma dos pesos é ${soma}, precisa dar 100`];
}
export function calcular(fontes, pesos) {
  return { geral: null, dimensoes: Object.entries(pesos).map(([chave, peso]) => ({ chave, nome: chave, nota: null, peso, motivo: 'sem dado' })) };
}
export function tendencia(historico) { return historico.length < 2 ? null : historico.at(-1).geral - historico.at(-2).geral; }
