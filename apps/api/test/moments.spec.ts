import { normalize, searchMoments, SearchSegment } from '../src/clips/moments';

function seg(start: number, text: string): SearchSegment {
  const raw = text.split(' ');
  return { start, end: start + raw.length * 0.5, text, words: raw.map((w, i) => ({ start: start + i * 0.5, end: start + (i + 1) * 0.5, word: w })) };
}

const segments = [
  seg(10, 'Klk mi gente, bienvenidos al stream'),
  seg(40, '¡Capicúa! No lo puedo creer'),
  seg(90, 'Se están riendo todos de la jugada'),
  seg(120, 'Doble seis en la mesa'),
  seg(125, 'y se trancó el juego'),
  seg(300, 'El partido de dominó terminó en tranque'),
];

describe('Encontrar momentos', () => {
  it('normaliza tildes, mayúsculas y puntuación', () => {
    expect(normalize('¡Capicúa, MANO!')).toBe('capicua mano');
  });

  it('encuentra la palabra sin importar tildes y da el instante exacto', () => {
    const [m] = searchMoments(segments, 'capicua');
    expect(m.at).toBe(40);
    expect(m.matches).toEqual(['¡Capicúa!']);
  });

  it('acepta variaciones de la palabra', () => {
    expect(searchMoments(segments, 'ríen').map((m) => m.at)).toEqual([91]);
    expect(searchMoments(segments, 'jugando').map((m) => m.at)).toContain(93);
  });

  it('una frase partida entre dos segmentos se encuentra en el primero', () => {
    const [m] = searchMoments(segments, 'la mesa y se trancó');
    expect(m.start).toBe(120);
    expect(m.text).toContain('trancó');
  });

  it('ignora palabras vacías y no devuelve resultados sin coincidencias', () => {
    expect(searchMoments(segments, 'el de la')).toEqual([]);
    expect(searchMoments(segments, 'pizza')).toEqual([]);
    expect(searchMoments(segments, 'a')).toEqual([]);
  });

  it('la frase exacta puntúa más que las palabras sueltas', () => {
    const r = searchMoments(segments, 'doble seis');
    expect(r[0].at).toBe(120);
    expect(r[0].score).toBe(1);
  });
});
