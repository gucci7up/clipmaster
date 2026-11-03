"""
Léxicos para el análisis semántico sin LLM (español con variantes dominicanas + inglés).
Se comparan sobre texto normalizado (minúsculas, sin tildes).
"""

from __future__ import annotations

import re
import unicodedata


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text.lower())
    return "".join(c for c in text if not unicodedata.combining(c))


LAUGHTER = re.compile(r"\b(?:j[aeiou]){2,}j?\b|\b(?:h[ae]){2,}h?\b|\blol\b|\blmao\b|\bme muero\b|\bque risa\b|\bme parto\b|\b\[?risas\]?\b")

EXCLAMATIONS = [
    "wow", "guau", "dios mio", "ay dios", "no puede ser", "increible", "brutal", "tremendo", "tremenda",
    "que es eso", "mira eso", "oh my god", "oh no", "what", "no way", "omg", "uff", "ufff", "madre mia",
    "que locura", "esta loco", "estas loco", "de verdad", "en serio", "imposible", "epico", "bestial",
    # Dominicano coloquial
    "diablo", "diache", "concho", "coño", "co%o", "mano", "manito", "klk", "que lo que", "vaina", "tiguere",
    "jevi", "chevere", "bacano", "ta to", "dique", "anja", "mi loco", "loco", "que chulo", "un chin", "na guara",
]

STORY_START = [
    "te cuento", "les cuento", "una vez", "resulta que", "imaginate", "imaginense", "fijate", "un dia",
    "el otro dia", "la historia", "lo que paso", "y de repente", "de pronto", "so then", "one time",
    "let me tell you", "story", "entonces llega", "y entonces",
]

CONCLUSION = [
    "al final", "por eso", "y asi fue", "moraleja", "en conclusion", "total que", "y ahi fue", "por fin",
    "in the end", "that's why", "and that's how", "lo que aprendi", "la leccion",
]

EDUCATIONAL = [
    "la clave", "el secreto", "consejo", "tip", "truco", "paso uno", "primer paso", "lo importante",
    "lo que tienes que saber", "por que", "como hacer", "la razon", "significa", "es decir", "por ejemplo",
    "the key", "the secret", "here's how", "step one", "important", "for example",
]

DEBATE = [
    "no estoy de acuerdo", "eso no es asi", "mentira", "discuplame", "disculpame", "pero escucha", "pero mira",
    "no, no", "callate", "eso es falso", "que va", "ni hablar", "you're wrong", "that's not true", "no no no",
    "deja que termine", "tu no sabes",
]

DOMINO = [
    "capicua", "kapicua", "tranque", "tranco", "trancado", "se tranco", "me tranque", "domino", "pase", "paso",
    "chuchazo", "chucha", "doble seis", "doble blanco", "la blanca", "pollona", "agua", "dale agua", "pegue",
    "pego", "gane", "ganamos", "perdimos", "tantos", "tranca", "la mano", "salida", "cuadrar",
]


def count_phrases(norm_text: str, phrases: list[str]) -> int:
    n = 0
    for p in phrases:
        if " " in p or len(p) > 3:
            n += norm_text.count(p)
        else:
            n += len(re.findall(rf"\b{re.escape(p)}\b", norm_text))
    return n
