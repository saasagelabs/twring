import type { ApprovalAction, SpeakerLanguage } from '@twring/contracts';

/**
 * Twring's own spoken lines in each language a person can speak (ADR-036). English is exactly
 * the lines Twring spoke before languages existed. Lines avoid grammatical gender where the
 * language marks it (Hindi, Russian), because Twring speaks in the agent's voice.
 *
 * Spoken yes/no answers to approvals exist for `en`, `hi` and `es`; every other language asks
 * the person to answer on the phone, and a spoken answer is not taken as a decision.
 */
export type LineLanguage = SpeakerLanguage;

export interface Lines {
  /** Acknowledgements, taken in turn. None may be only stop words (an echo would read as "wait"). */
  ack: readonly [string, string, string];
  progress: string;
  stopped: string;
  /** After an answer that broke off: says only that the rest was lost, nothing about the work. */
  replyBroken: string;
  approvalPrompt: (agentName: string, action: ApprovalAction) => string;
  approvalReask: string;
  approvalTimeout: string;
  approvalDenied: string;
}

type Phrases = Record<ApprovalAction, string>;

const EN_PHRASES: Phrases = {
  edit_files: 'change files',
  delete_files: 'delete files',
  run_command: 'run a command',
  read_files: 'read files',
  fetch_web: 'open a web page',
  other: 'do something that needs your OK',
};

const ES_PHRASES: Phrases = {
  edit_files: 'cambiar archivos',
  delete_files: 'borrar archivos',
  run_command: 'ejecutar un comando',
  read_files: 'leer archivos',
  fetch_web: 'abrir una página web',
  other: 'hacer algo que necesita tu permiso',
};

/** Hindi, oblique form before "की अनुमति चाहिए" ("needs permission to ..."). */
const HI_PHRASES: Phrases = {
  edit_files: 'फ़ाइलें बदलने',
  delete_files: 'फ़ाइलें हटाने',
  run_command: 'एक कमांड चलाने',
  read_files: 'फ़ाइलें पढ़ने',
  fetch_web: 'एक वेब पेज खोलने',
  other: 'कुछ करने',
};

const FR_PHRASES: Phrases = {
  edit_files: 'modifier des fichiers',
  delete_files: 'supprimer des fichiers',
  run_command: 'exécuter une commande',
  read_files: 'lire des fichiers',
  fetch_web: 'ouvrir une page web',
  other: 'faire quelque chose qui demande votre accord',
};

const DE_PHRASES: Phrases = {
  edit_files: 'Dateien ändern',
  delete_files: 'Dateien löschen',
  run_command: 'einen Befehl ausführen',
  read_files: 'Dateien lesen',
  fetch_web: 'eine Webseite öffnen',
  other: 'etwas tun, das Ihre Zustimmung braucht',
};

const RU_PHRASES: Phrases = {
  edit_files: 'изменить файлы',
  delete_files: 'удалить файлы',
  run_command: 'выполнить команду',
  read_files: 'прочитать файлы',
  fetch_web: 'открыть веб-страницу',
  other: 'сделать то, что требует вашего разрешения',
};

const PT_PHRASES: Phrases = {
  edit_files: 'alterar arquivos',
  delete_files: 'apagar arquivos',
  run_command: 'executar um comando',
  read_files: 'ler arquivos',
  fetch_web: 'abrir uma página da web',
  other: 'fazer algo que precisa da sua permissão',
};

/** Japanese, before "許可を求めています" ("is asking permission to ..."). */
const JA_PHRASES: Phrases = {
  edit_files: 'ファイルを変更する',
  delete_files: 'ファイルを削除する',
  run_command: 'コマンドを実行する',
  read_files: 'ファイルを読む',
  fetch_web: 'ウェブページを開く',
  other: '確認が必要な操作をする',
};

const IT_PHRASES: Phrases = {
  edit_files: 'modificare dei file',
  delete_files: 'eliminare dei file',
  run_command: 'eseguire un comando',
  read_files: 'leggere dei file',
  fetch_web: 'aprire una pagina web',
  other: 'fare qualcosa che richiede il tuo consenso',
};

const NL_PHRASES: Phrases = {
  edit_files: 'bestanden wijzigen',
  delete_files: 'bestanden verwijderen',
  run_command: 'een opdracht uitvoeren',
  read_files: 'bestanden lezen',
  fetch_web: 'een webpagina openen',
  other: 'iets doen waarvoor je toestemming nodig is',
};

export const LINES: Record<LineLanguage, Lines> = {
  en: {
    ack: ['Okay, one moment.', 'Sure, let me see.', 'Right, let me think.'],
    progress: 'Still working on it.',
    stopped: 'Okay, stopped.',
    replyBroken: 'I lost the rest of that answer.',
    approvalPrompt: (agent, action) =>
      `${agent} wants to ${EN_PHRASES[action]}. Say yes or no, or tap on your phone.`,
    approvalReask: 'Please say yes or no, or tap on your phone.',
    approvalTimeout: 'No answer, so I said no.',
    approvalDenied: 'Okay, I said no.',
  },
  es: {
    ack: ['De acuerdo, veamos.', 'Claro, déjame ver.', 'Bien, déjame pensar.'],
    progress: 'Sigo trabajando en ello.',
    stopped: 'De acuerdo, me detengo.',
    replyBroken: 'Lo siento, perdí el resto de esa respuesta.',
    approvalPrompt: (agent, action) =>
      `${agent} quiere ${ES_PHRASES[action]}. Di sí o no, o toca en tu teléfono.`,
    approvalReask: 'Por favor, di sí o no, o toca en tu teléfono.',
    approvalTimeout: 'No hubo respuesta, así que dije que no.',
    approvalDenied: 'De acuerdo, dije que no.',
  },
  hi: {
    ack: ['ठीक है, ज़रा देखते हैं।', 'अच्छा, एक पल दीजिए।', 'जी, सोचने दीजिए।'],
    progress: 'अभी भी इस पर काम चल रहा है।',
    stopped: 'ठीक है, रोक दिया।',
    replyBroken: 'माफ़ कीजिए, उस जवाब का बाकी हिस्सा खो गया।',
    approvalPrompt: (agent, action) =>
      `${agent} को ${HI_PHRASES[action]} की अनुमति चाहिए। हाँ या ना बोलिए, या फ़ोन पर टैप कीजिए।`,
    approvalReask: 'कृपया हाँ या ना बोलिए, या फ़ोन पर टैप कीजिए।',
    approvalTimeout: 'कोई जवाब नहीं आया, इसलिए मैंने मना कर दिया।',
    approvalDenied: 'ठीक है, मैंने मना कर दिया।',
  },
  fr: {
    ack: ["D'accord, voyons.", 'Bien sûr, je regarde.', 'Bon, je réfléchis.'],
    progress: 'Je suis encore dessus.',
    stopped: "D'accord, j'arrête.",
    replyBroken: "Désolé, j'ai perdu la fin de cette réponse.",
    approvalPrompt: (agent, action) =>
      `${agent} veut ${FR_PHRASES[action]}. Répondez sur votre téléphone.`,
    approvalReask: 'Merci de répondre sur votre téléphone.',
    approvalTimeout: "Pas de réponse, alors j'ai refusé.",
    approvalDenied: "D'accord, j'ai refusé.",
  },
  de: {
    ack: ['Okay, einen Moment.', 'Klar, ich schaue mal.', 'Gut, ich überlege kurz.'],
    progress: 'Ich arbeite noch daran.',
    stopped: 'Okay, gestoppt.',
    replyBroken: 'Entschuldigung, der Rest dieser Antwort ist verloren gegangen.',
    approvalPrompt: (agent, action) =>
      `${agent} möchte ${DE_PHRASES[action]}. Bitte antworten Sie auf Ihrem Telefon.`,
    approvalReask: 'Bitte antworten Sie auf Ihrem Telefon.',
    approvalTimeout: 'Keine Antwort, also habe ich abgelehnt.',
    approvalDenied: 'Okay, ich habe abgelehnt.',
  },
  ru: {
    ack: ['Хорошо, одну секунду.', 'Сейчас посмотрю.', 'Так, дайте подумать.'],
    progress: 'Всё ещё работаю над этим.',
    stopped: 'Хорошо, останавливаюсь.',
    replyBroken: 'Извините, остаток этого ответа потерялся.',
    approvalPrompt: (agent, action) =>
      `${agent} хочет ${RU_PHRASES[action]}. Ответьте на телефоне.`,
    approvalReask: 'Пожалуйста, ответьте на телефоне.',
    approvalTimeout: 'Ответа не было, поэтому запрос отклонён.',
    approvalDenied: 'Хорошо, запрос отклонён.',
  },
  pt: {
    ack: ['Certo, um momento.', 'Claro, vou ver.', 'Bom, vou pensar.'],
    progress: 'Ainda estou nisso.',
    stopped: 'Certo, parei.',
    replyBroken: 'Desculpe, perdi o resto dessa resposta.',
    approvalPrompt: (agent, action) =>
      `${agent} quer ${PT_PHRASES[action]}. Responda no seu telefone.`,
    approvalReask: 'Por favor, responda no seu telefone.',
    approvalTimeout: 'Sem resposta, então eu recusei.',
    approvalDenied: 'Certo, eu recusei.',
  },
  ja: {
    ack: ['はい、少々お待ちください。', '確認しますね。', 'ちょっと考えますね。'],
    progress: 'まだ作業中です。',
    stopped: 'はい、止めました。',
    replyBroken: 'すみません、その回答の続きが途切れました。',
    approvalPrompt: (agent, action) =>
      `${agent}が${JA_PHRASES[action]}許可を求めています。スマートフォンで答えてください。`,
    approvalReask: 'スマートフォンで答えてください。',
    approvalTimeout: '応答がなかったので、拒否しました。',
    approvalDenied: 'はい、拒否しました。',
  },
  it: {
    ack: ['Va bene, un momento.', 'Certo, vediamo.', 'Bene, ci penso un attimo.'],
    progress: 'Ci sto ancora lavorando.',
    stopped: 'Va bene, mi fermo.',
    replyBroken: 'Scusa, ho perso il resto di quella risposta.',
    approvalPrompt: (agent, action) =>
      `${agent} vuole ${IT_PHRASES[action]}. Rispondi sul telefono.`,
    approvalReask: 'Per favore, rispondi sul telefono.',
    approvalTimeout: 'Nessuna risposta, quindi ho rifiutato.',
    approvalDenied: 'Va bene, ho rifiutato.',
  },
  nl: {
    ack: ['Oké, een momentje.', 'Tuurlijk, ik kijk even.', 'Goed, even denken.'],
    progress: 'Ik ben er nog mee bezig.',
    stopped: 'Oké, gestopt.',
    replyBroken: 'Excuses, de rest van dat antwoord is verloren gegaan.',
    approvalPrompt: (agent, action) =>
      `${agent} wil ${NL_PHRASES[action]}. Antwoord op je telefoon.`,
    approvalReask: 'Antwoord alsjeblieft op je telefoon.',
    approvalTimeout: 'Geen antwoord, dus ik heb geweigerd.',
    approvalDenied: 'Oké, ik heb geweigerd.',
  },
};

/** Spoken approval words beyond English, which every speaker may also use ("yes", "okay"). */
export const SPOKEN_APPROVAL_WORDS: Partial<
  Record<
    LineLanguage,
    {
      yes: readonly string[];
      no: readonly string[];
      /** Polite words allowed around an answer ("sí, por favor"), as English "please" is. */
      fillers: readonly string[];
    }
  >
> = {
  hi: {
    yes: [
      'हाँ',
      'हां',
      'हा',
      'हाँ जी',
      'जी हाँ',
      'जी',
      'ठीक है',
      'कर दो',
      'कर दीजिए',
      'करो',
      'चलो',
      'बिल्कुल',
      'haan',
      'han',
      'haa',
      'ha',
      'theek hai',
      'thik hai',
      'kar do',
      'ji',
      'bilkul',
    ],
    no: [
      'ना',
      'नहीं',
      'नही',
      'मत करो',
      'मत कीजिए',
      'रहने दो',
      'रहने दीजिए',
      'nahi',
      'nahin',
      'na',
      'mat karo',
      'rehne do',
    ],
    fillers: ['प्लीज़', 'प्लीज', 'धन्यवाद', 'शुक्रिया', 'please', 'shukriya', 'dhanyavaad'],
  },
  es: {
    yes: [
      'sí',
      'si',
      'claro',
      'vale',
      'dale',
      'adelante',
      'hazlo',
      'de acuerdo',
      'correcto',
      'bueno',
      'por supuesto',
      'okey',
    ],
    no: ['no', 'nop', 'todavía no', 'ahora no', 'nunca', 'no lo hagas', 'mejor no'],
    fillers: ['por favor', 'gracias', 'muchas gracias', 'oye'],
  },
};

/** Words that only ask Twring to stop talking (ADR-017), beyond English. */
export const STOP_WORDS: Partial<Record<LineLanguage, readonly string[]>> = {
  hi: [
    'रुको',
    'रुकिए',
    'रुको ज़रा',
    'एक मिनट',
    'एक सेकंड',
    'बस',
    'सॉरी',
    'माफ़ कीजिए',
    'ruko',
    'rukiye',
    'ek minute',
    'ek second',
    'bas',
  ],
  es: ['espera', 'espere', 'para', 'alto', 'un momento', 'un segundo', 'perdón', 'disculpa'],
};
