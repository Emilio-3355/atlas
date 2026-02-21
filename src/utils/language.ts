const SPANISH_MARKERS = [
  /\b(hola|oye|mira|dale|por favor|gracias|qué|cómo|cuándo|dónde|quiero|necesito|puedes|hazme|dime|bueno|claro|vale|okey|neta|chido|wey|güey|mande|ándale|pues|así|también|ahora|luego|después|mañana|hoy|ayer)\b/i,
  /[áéíóúñ¿¡]/,
];

export function detectLanguage(text: string): 'es' | 'en' {
  for (const marker of SPANISH_MARKERS) {
    if (marker.test(text)) return 'es';
  }
  return 'en';
}
