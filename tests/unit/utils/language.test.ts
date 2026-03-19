import { describe, it, expect } from 'vitest';
import { detectLanguage } from '../../../src/utils/language.js';

describe('detectLanguage', () => {
  it('returns "es" for "hola como estas"', () => {
    expect(detectLanguage('hola como estas')).toBe('es');
  });

  it('returns "es" for text with accent chars "café"', () => {
    expect(detectLanguage('me gusta el café')).toBe('es');
  });

  it('returns "es" for "qué opinas"', () => {
    expect(detectLanguage('qué opinas de esto')).toBe('es');
  });

  it('returns "es" for "necesito ayuda"', () => {
    expect(detectLanguage('necesito ayuda con algo')).toBe('es');
  });

  it('returns "en" for "hello how are you"', () => {
    expect(detectLanguage('hello how are you')).toBe('en');
  });

  it('returns "en" for empty string', () => {
    expect(detectLanguage('')).toBe('en');
  });

  it('returns "en" for numbers only "12345"', () => {
    expect(detectLanguage('12345')).toBe('en');
  });

  it('returns "es" for inverted question mark "¿como?"', () => {
    expect(detectLanguage('¿como?')).toBe('es');
  });

  it('returns "es" for inverted exclamation "¡dale!"', () => {
    expect(detectLanguage('¡dale!')).toBe('es');
  });

  it('returns "es" for Mexican slang "neta wey"', () => {
    expect(detectLanguage('neta wey eso esta chido')).toBe('es');
  });

  it('returns "es" for "por favor"', () => {
    expect(detectLanguage('por favor hazme un resumen')).toBe('es');
  });

  it('returns "es" for "gracias"', () => {
    expect(detectLanguage('gracias por la ayuda')).toBe('es');
  });

  it('returns "es" for "mañana"', () => {
    expect(detectLanguage('lo vemos mañana')).toBe('es');
  });

  it('returns "es" for ñ character', () => {
    expect(detectLanguage('año nuevo')).toBe('es');
  });

  it('returns "en" for plain English', () => {
    expect(detectLanguage('what is the weather today')).toBe('en');
  });
});
