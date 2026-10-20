// Dublê de central/score/escala.mjs (contrato C4).
export const ESCALA_PADRAO = { carga: 35, dados: 25, 'estado-infra': 20, 'custo-unidade': 10, manutencao: 10 };
export function validarEscala(obj) {
  const soma = Object.values(obj).reduce((a, b) => a + Number(b), 0);
  return soma === 100 ? [] : [`a soma dos pesos é ${soma}, precisa dar 100`];
}
export function calcularEscala(fontes, pesos) {
  return { geral: null, eixos: Object.entries(pesos).map(([chave, peso]) => ({ chave, nome: chave, nota: null, peso, motivo: 'sem dado' })), primeiroGargalo: null };
}
