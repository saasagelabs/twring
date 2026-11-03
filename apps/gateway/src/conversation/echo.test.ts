import { describe, expect, it } from 'vitest';

import {
  ECHO_LOOKAHEAD_MS,
  ECHO_LOOKBACK_MS,
  audibleText,
  echoPrefixLength,
  echoWindow,
  echoWords,
  isEcho,
  judgeTail,
  newWords,
} from './echo';

const window = echoWindow(['It’s sunny in Paris today, around twenty degrees.']);

describe('echo normalisation', () => {
  it('splits lowercase letter/number runs, Unicode-aware, contractions expanded', () => {
    expect(echoWords("It's 20°C in Zürich, isn’t it?")).toEqual([
      'it',
      'is',
      'twenty',
      'c',
      'in',
      'zürich',
      'is',
      'not',
      'it',
    ]);
  });

  it('numbers 0–99 become words; larger ones stay digits', () => {
    expect(echoWords('0 4 13 20 21 99 100')).toEqual([
      'zero',
      'four',
      'thirteen',
      'twenty',
      'twenty',
      'one',
      'ninety',
      'nine',
      '100',
    ]);
    expect(echoWords('4pm')).toEqual(['four', 'pm']);
  });

  it('ok/okay, a.m./p.m., percent, hyphens and contractions match either way', () => {
    const same = (a: string, b: string) => expect(echoWords(a)).toEqual(echoWords(b));
    same('OK', 'okay');
    same('at 3 p.m.', 'at three pm');
    same('9 a.m.', 'nine am');
    same('20%', 'twenty percent');
    same('e-mail', 'email');
    same('follow-up', 'follow up');
    same('twenty-one', 'twenty one');
    same("don't", 'do not');
    same('I’m', 'i am');
    same("you're", 'you are');
    same("can't", 'can not');
    same('cannot', 'can not');
    same("won't", 'will not');
  });
});

describe('echo judging', () => {
  it('an empty or wordless tail is echo', () => {
    expect(isEcho('', window)).toBe(true);
    expect(isEcho(' ... ', window)).toBe(true);
  });

  it('a tail is echo only when every word is in the window', () => {
    expect(isEcho('Paris', window)).toBe(true);
    expect(isEcho('its sunny', window)).toBe(false); // "its" is not "it is"
    expect(isEcho('it is sunny', window)).toBe(true);
    expect(isEcho('stop', window)).toBe(false);
    expect(isEcho('sunny stop', window)).toBe(false);
    expect(isEcho('in Paris today wait', window)).toBe(false);
  });

  it('three or more words also need 60% of their pairs in the window', () => {
    expect(isEcho('sunny in Paris today', window)).toBe(true);
    expect(isEcho('today Paris sunny', window)).toBe(false); // same words, not the agent's order
    expect(judgeTail(['sunny', 'in', 'paris'], window)).toEqual({
      echo: true,
      words: 3,
      overlap: 1,
    });
  });

  it('pairs never span two separate stretches of speech', () => {
    const two = echoWindow(['Hello there', 'friend of mine']);
    expect(isEcho('there friend of', two)).toBe(false); // 1/2 pairs
    expect(isEcho('friend of mine', two)).toBe(true);
  });

  it('only words new since the previous partial are judged', () => {
    expect(newWords(undefined, ['a', 'b'])).toEqual(['a', 'b']);
    expect(newWords(['a'], ['a', 'b', 'c'])).toEqual(['b', 'c']);
    expect(newWords(['a', 'b'], ['a', 'b'])).toEqual([]);
    expect(newWords(['a', 'x'], ['a', 'b'])).toEqual(['a', 'b']); // revised: judged whole
    expect(newWords(['a', 'b'], ['a'])).toEqual(['a']);
  });

  it('a commit is echo only if the leading run in the agent’s order covers all of it', () => {
    expect(echoPrefixLength(echoWords('sunny in Paris'), window)).toBe(3);
    expect(echoPrefixLength(echoWords('sunny Paris today'), window)).toBe(3); // STT dropped "in"
    expect(echoPrefixLength(echoWords('sunny in Paris stop'), window)).toBe(3);
    expect(echoPrefixLength(echoWords('stop sunny in Paris'), window)).toBe(0);
    expect(echoPrefixLength(echoWords('twenty degrees sunny'), window)).toBe(2); // not in order
  });
});

describe('audible window', () => {
  // One-letter words: expanding to word boundaries adds at most one character at each end.
  const text = 'x.'.repeat(500);
  const near = (actual: number, expected: number) => {
    expect(actual).toBeGreaterThanOrEqual(expected);
    expect(actual).toBeLessThanOrEqual(expected + 2);
  };
  it('at the default rate: 4 s back, 1 s ahead, widened by 15% of the position', () => {
    // 14 chars/s: at 10 s, position 140, back 56, ahead 14, slack 21 → chars 63 to 175.
    near(audibleText(text, 10_000).length, 175 - 63);
    near(audibleText(text, 0).length, (ECHO_LOOKAHEAD_MS / 1000) * 14);
    expect(ECHO_LOOKBACK_MS).toBe(4000);
  });

  it('uses the real rate once the total audio length is known', () => {
    // 1000 chars over 10 s: at 5 s, position 500, back 400, ahead 100, slack 75 → 25 to 675.
    near(audibleText(text, 5000, 10_000).length, 675 - 25);
  });

  it('expands to whole words and never passes the end', () => {
    expect(audibleText('Hello wonderful world', 0)).toBe('Hello wonderful');
    expect(audibleText('Hi there.', 60_000)).toBe('Hi there.');
    expect(audibleText('', 1000)).toBe('');
  });
});

// Verifier attack pass, updated to the audible-window rule (ADR-015). These pin behaviour so the
// trade-offs are visible; a test here failing after a change means that trade-off moved.
describe('echo rejection limits (verifier)', () => {
  const INTERRUPTIONS = [
    'stop',
    'wait',
    'no',
    'yes',
    'okay',
    'ok',
    'hold on',
    'hang on',
    'wait wait',
    'no no',
    'stop please',
    'excuse me',
    'sorry',
    'actually',
    'hey',
    'one sec',
    'never mind',
    'thats enough',
    'hello',
    'what',
    'go back',
    'repeat that',
    'no stop',
    'wait what',
    'stop stop',
  ];
  const swallowed = (text: string, playedMs: number) => {
    const w = echoWindow([audibleText(text, playedMs)]);
    return INTERRUPTIONS.filter((i) => isEcho(i, w));
  };
  const story =
    'Once upon a time there was a little fox who lived at the edge of the forest. Every morning ' +
    'she would wait by the river and watch the boats go by. One day an old man stopped his boat ' +
    'and said, hey, do you want to come with me? No, said the fox, I can’t leave my home. But the ' +
    'man said okay, then I will come back tomorrow, and if you say yes, we will go together. So ' +
    'the next day the fox was ready. She said yes, and they sailed down the river, past towns ' +
    'and hills, until they reached the sea. Hold on, said the man, look at that. Right in front ' +
    'of them, a whale jumped out of the water. Wow, said the fox. That was the best day of her ' +
    'life, and she never forgot it. Now, what else would you like to hear? I could tell you ' +
    'another story, or stop here if you are tired.';

  it('a short factual answer swallows none of 25 common short interruptions', () => {
    expect(
      swallowed(
        'Sure. It’s sunny in Paris today, around twenty degrees, with a light breeze.',
        2000,
      ),
    ).toEqual([]);
  });

  it('a long answer swallows only interruptions that are words audible right now', () => {
    // Was: over half of them, anywhere in the story. Now only the window around playout counts.
    expect(swallowed(story, 1000)).toEqual([]);
    expect(swallowed(story, 12_000)).toEqual(['wait', 'wait wait', 'hey']); // "…wait by the river…hey…"
    expect(swallowed(story, 16_000)).toEqual(['no', 'no no', 'hey']);
  });

  it('a caller repeating the words the agent is saying right now is echo', () => {
    const w = echoWindow(['Would you like the red one or the blue one?']);
    expect(isEcho('blue', w)).toBe(true);
    expect(isEcho('the blue one', w)).toBe(true);
    // Was echo (2/3 pairs). Now "please" is not the agent's word: real.
    expect(isEcho('the blue one please', w)).toBe(false);
    const time = echoWindow(['Shall I book it for tomorrow at 4 pm?']);
    expect(isEcho('tomorrow at four p.m.', time)).toBe(true); // a read-back while it plays
  });

  it('a caller word appended to an echo run is heard', () => {
    const w = echoWindow(['Option one is the red one. Option two is the blue one.']);
    // Was echo until the caller said "stop" four times. Now the new word is judged on its own.
    expect(isEcho('option one is stop', w)).toBe(false);
    expect(
      judgeTail(newWords(echoWords('option one is'), echoWords('option one is stop')), w),
    ).toMatchObject({ echo: false, words: 1 });
    expect(echoPrefixLength(echoWords('option one is the red one stop'), w)).toBe(6); // of 7
  });

  it('echo misheard by one word is not echo (a false barge-in; known limit)', () => {
    const w = echoWindow(['It’s sunny in Paris today, around twenty degrees.']);
    expect(isEcho('it is sonny', w)).toBe(false);
    expect(isEcho('sunny in parish', w)).toBe(false);
    expect(isEcho('it is sunny in parish today around twenty', w)).toBe(false);
  });

  it('TTS text and STT text formats are normalised: numbers, OK/okay, contractions', () => {
    const digits = echoWindow(['It will be around 20 degrees at 3 pm.']);
    expect(isEcho('around twenty degrees', digits)).toBe(true);
    expect(isEcho('at three p.m.', digits)).toBe(true);
    expect(isEcho('around 20 degrees', echoWindow(['It will be around twenty degrees.']))).toBe(
      true,
    );
    expect(isEcho('okay', echoWindow(['OK, done.']))).toBe(true);
    expect(isEcho('it is sunny', echoWindow(['It’s sunny.']))).toBe(true);
    expect(isEcho('email', echoWindow(['I sent the e-mail.']))).toBe(true);
  });

  it('smart quotes, hyphens and case are normalised', () => {
    const w = echoWindow(['Don’t worry, the follow-up is booked.']);
    expect(isEcho("don't", w)).toBe(true);
    expect(isEcho('follow up', w)).toBe(true);
    expect(isEcho('FOLLOW-UP', w)).toBe(true);
  });
});

// Final pass on normalisation and window width (ADR-015 v2). "BUG:" asserts intended behaviour
// and fails today; "RISK:" pins current behaviour.
describe('echo normalisation and window width, final pass (verifier)', () => {
  it('BUG: a digit range is spoken "N to M", not joined into one number', () => {
    expect(echoWords('3-5 days')).toEqual(['three', 'to', 'five', 'days']); // today: thirty five
    expect(echoWords('5-10 minutes')).toEqual(['five', 'to', 'ten', 'minutes']); // today: "510"
  });

  it('RISK: spoken forms the normaliser does not map (echo transcribed this way cuts the answer)', () => {
    const inWindow = (agent: string, stt: string) => isEcho(stt, echoWindow([agent]));
    expect(inWindow('It costs 150 dollars.', 'it costs one hundred fifty dollars')).toBe(false);
    expect(inWindow('It is 3.5 miles away.', 'it is three point five miles away')).toBe(false);
    expect(inWindow('That is $5.', 'that is five dollars')).toBe(false);
    expect(inWindow('On the 1st of May.', 'on the first of may')).toBe(false);
    // ":00" becomes a phantom "zero" that breaks the agent's word pairs ("ten zero tomorrow").
    expect(inWindow('At 10:00 tomorrow.', 'at 10 tomorrow')).toBe(false);
    expect(inWindow('In 2026.', 'in twenty twenty six')).toBe(false);
    expect(inWindow("It's ready.", 'its ready')).toBe(false);
    expect(inWindow('Its lid is open.', "it's lid is open")).toBe(false);
    // Symmetric forms are fine.
    expect(inWindow('We\u2019ll call at 4:30.', "we'll call at four thirty")).toBe(true);
    expect(inWindow('Caf\u00e9 at 5 p.m.', 'caf\u00e9 at 5 PM')).toBe(true);
  });

  // Was RISK (15% slack uncapped: ~23 s window late in a long answer).
  it('late in a long answer the slack is capped at ECHO_MAX_SLACK_MS; a finished one looks back only', () => {
    const text = 'x '.repeat(900); // 1800 chars, 120 s at 15 chars/s
    // Known rate, 60 s in: position 900, back 60 + 30, ahead 15 + 30 -> ~135 chars (~9 s).
    const middle = audibleText(text, 60_000, 120_000).length;
    expect(middle).toBeGreaterThan(130);
    expect(middle).toBeLessThan(140);
    // A finished generation: the last ECHO_LOOKBACK_MS at the known rate, no slack (~60 chars).
    const tail = audibleText(text, Number.POSITIVE_INFINITY, 120_000).length;
    expect(tail).toBeGreaterThan(58);
    expect(tail).toBeLessThan(63);
  });

  it('echoPrefixLength: STT dropping up to 2 agent words is echo; 3 is not; order is required', () => {
    const w = echoWindow(['one two three four five six seven']);
    expect(echoPrefixLength(echoWords('one four'), w)).toBe(2);
    expect(echoPrefixLength(echoWords('one five'), w)).toBe(1);
    expect(echoPrefixLength(echoWords('three two'), w)).toBe(1);
    expect(echoPrefixLength([], w)).toBe(0);
    expect(echoPrefixLength(echoWords('one'), echoWindow())).toBe(0);
  });
});
