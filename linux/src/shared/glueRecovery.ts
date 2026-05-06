/**
 * Recover spaces in run-on assistant text using greedy longest-match
 * against a compact English + assistant-domain word list.
 */

const COMMON = `
a an and are as at be been but by can could did do does doing done down for from get got had has have he her hers him his how i if im in into is it its just let like me might more much my new next no nor not now of off ok on once one only or our out over own put re really said say see she should so such than that the their them then these they thing this those through to today too try two under up usa use very want was way we weeks were what when where which while who why will wins with wont would yeah year years yes yet you youre your yours
about again all also always april ask asked august auto away back basic become began begin being below best better between bill black blue body book books both brand bring browser build bulletin business calendar call came can cannot card cars case cents certainly chain change chapter charge chart check checking choose chrome city clean clear clipboard close cold come comma complete compose computer concatenate confirm connection consider contacts content continue conversation cookies cool corp correct correctness could country couple course cover create crowd csv curled cursor cute cut dark data databank december decide deep default define definitely delete describe described description desktops detail didnt directory disallow disk dns doc docx document doesnt dollar dont doorway double downloadable downloaded downloads dozen draft dramas drive drop during each east easy eclipse editor effect eleven ellipse email emails empty enabled ends english enough epub esp especially et ethereum event evenly everyone everything exact except executive exist expedition explain expressive extension external eyes fair fall family fashions fast favorites february feel feeling few fifty file files finally firefox first five flash floor folder folders follow footer for forty found fourth friday friend friends from front full further future game gave generalized get gmail gnu going good google got gpg graduate gratefully greater greet grin group gsm guess guest guys had hallucinate hanger happen happened happy harbour hardware has hates have headset heard hello help here herd hi hid hidden high hires him hindi hiring his history hockey hoe hold hometown honestly horizons horse hourly hours hovered how hugs huge hundred hurried hurry husband hyphen ice ideas if ignite ill imitate important includes inbox indeed industry info innovation instead install into invite ipad ir is isnt issue ive january jess jobs join july june just keep keypad keys kinds knew known kong lab landing language larger largely later latin launch law leader leads learn least leave legal let letter libc license life like limited link linux list listen little live local log login long look looked looking looks lord lose lot lunch mac mailed mails mainland make manager many margin marked markets mass match matter maxim maybe meaning meat meeting meetings mention merge messages met midday might mile mind mine minutes miss missed mobile mod monday monitor month months moon more morning most mother mousepad move mozilla much music mutual name national near need needed needs neither net never nevertheless newest news next nice night ninety nobody node none noon nor north notes nothing november now null number numbers obvious october offer office older once online only open opened opens opera order other others our out outside over own pack page pages paid parents pass past pdf people perhaps person phone pictures piece place plan play please plus point possible post pounds power pretty preview previous print process program project projects property public pull purchase push put quarter question quietly quite radio raise ran rate rather read reader readme ready real reason received recently red regard release reminders reply report rest result return review right ring rise road room rooms root round run running said saturday save say scan school screenshot scroll search second section security see seemed seen send sense september series serve server set seven seventy several she short should show side signed simple since single sir site sixty size sleep smaller snow software someone sometimes son soon sound southern space spam speak spend sports spot spring stack staff stage standard start station stay steel stick still stock stop storage store story straight streets strong style subject such sunday supply support sure survey sweet switch sync system table tag take talking teams tell temperature ten terms test texas text thanks their them then these they thing thirty this those though thought thousand three thursday ticket time times tiny title today together tomorrow tone too toolbox tools topic topics total touch toward tower trade traffic train travel tree tried tries true try tuesday turns twenty two types ubuntu under understand unfortunately unless until up upload uploads url urls use used useful user users usually valley value various version via video voicemail volume vote wait walk wall want warmed was wash watch water waves ways we wear weather web weekdays wednesday week weeks weigh welcome well went west what when where whether which while white who whole why willingness window windshield winner wire wisely wish within without woman wonderful wooden word words wore work world worn would wrench write writes writing wrote www xd years yellow yes yesterday yet yoga york youngster your yours youre zero zip zone
`.trim();

const TECH = `
akram apk attachment attachments bash browser calendar capture clicky csv desktop doc docx download downloaded downloads email ffmpeg firefox folder from gmail gpg href html https imap inbox ipc jpeg json landing launched like likes linux logout looks mail makefile markdown mkdir mozilla mousepad newest no npm openssl outlook pdf png preview python readme recent scrape scraping screenshot slack sms stdin stdout stderr subject svg temp terminal thumbnails tmp transcript utc uzair vite voice wget wiki with without workspace xdg xml yaml yml zip unzip
`.trim();

const SORTED = [...new Set(`${COMMON} ${TECH}`.trim().split(/\s+/).filter(Boolean).map((w) => w.toLowerCase()))].sort(
  (a, b) => b.length - a.length
);

export function segmentGluedRun(lowerRun: string): string {
  if (!lowerRun.length) return '';
  let i = 0;
  const parts: string[] = [];
  while (i < lowerRun.length) {
    let matched = false;
    const slice = lowerRun.slice(i);
    for (const w of SORTED) {
      if (slice.startsWith(w)) {
        parts.push(w);
        i += w.length;
        matched = true;
        break;
      }
    }
    if (!matched) {
      // Unknown characters: consume as a single chunk until a known word starts
      let j = i + 1;
      while (j < lowerRun.length) {
        const nextSlice = lowerRun.slice(j);
        let found = false;
        for (const w of SORTED) {
          if (nextSlice.startsWith(w)) {
            found = true;
            break;
          }
        }
        if (found) break;
        j += 1;
      }
      parts.push(lowerRun.slice(i, j));
      i = j;
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export function recoverGluedEnglish(input: string): string {
  let s = input.trim();
  if (!s.length) return '';

  const chunks: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (/[a-zA-Z0-9]/.test(s[i])) {
      let j = i + 1;
      while (j < s.length && /[a-zA-Z0-9]/.test(s[j])) j += 1;
      const run = s.slice(i, j);
      const letters = run.replace(/[^a-zA-Z]/g, '');
      /** Skip runs with digits/timescodes so we don't break `2026`, `23:17:52`, hex, etc. */
      const gluedLongLetterOnly = letters.length >= 12 && !/\d/.test(run);
      chunks.push(gluedLongLetterOnly ? segmentGluedRun(run.toLowerCase()) : run);
      i = j;
    } else {
      chunks.push(s[i]);
      i += 1;
    }
  }

  s = chunks.join('');
  s = s.replace(/\s+/g, ' ');
  /* Do not normalize ':' here — breaks times like `23:17:52`. */
  s = s.replace(/\s*([,.!?])\s*/g, '$1 ');
  return s.replace(/\s+/g, ' ').trim();
}
