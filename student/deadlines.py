"""How soon is the time a message talks about?  Finds dates and clock times in text and measures them against the
moment the message was sent. Understands English, Spanish, French, German, Portuguese, Italian, Russian, Arabic and
Hebrew wording; another language is a few more words in the tables below. Deliberately small and forgiving: it produces features, not facts.

Times in messages are local, so the user's timezone matters: CLOCKWORK_TZ (an IANA name), default UTC.
"""
import math, os, re
from datetime import datetime, timedelta, date, time as dtime, timezone
from zoneinfo import ZoneInfo

def _tz():
    try: return ZoneInfo(os.environ.get('CLOCKWORK_TZ') or 'UTC')
    except Exception: return timezone.utc

_MONTHS = {m: i + 1 for i, m in enumerate(['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'])}
_DAYS = {d: i for i, d in enumerate(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])}          # Monday = 0, as datetime.weekday()
_MON = '|'.join(_MONTHS)

def _table(*rows):
    """Each row is twelve month names or seven weekday names (Monday first), with spelling variants separated by '/'."""
    return {name: i + (1 if len(row) == 12 else 0) for row in rows for i, cell in enumerate(row) for name in cell.split('/')}

# Month names as they are written after a day number ("5 de marzo", "5. März", "5 марта").
_XMONTHS = _table(
    ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre/setiembre', 'octubre', 'noviembre', 'diciembre'],
    ['janvier', 'février/fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août/aout', 'septembre', 'octobre', 'novembre', 'décembre/decembre'],
    ['januar', 'februar', 'märz/maerz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'],
    ['janeiro', 'fevereiro', 'março/marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'],
    ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
    ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
    ['يناير', 'فبراير', 'مارس', 'أبريل/ابريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس/اغسطس', 'سبتمبر', 'أكتوبر/اكتوبر', 'نوفمبر', 'ديسمبر'],
    ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'])
_XDAYS = _table(
    ['lunes', 'martes', 'miércoles/miercoles', 'jueves', 'viernes', 'sábado/sabado', 'domingo'],
    ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'],
    ['montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag/sonnabend', 'sonntag'],
    ['segunda-feira', 'terça-feira/terca-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado', 'domingo'],
    ['lunedì/lunedi', 'martedì/martedi', 'mercoledì/mercoledi', 'giovedì/giovedi', 'venerdì/venerdi', 'sabato', 'domenica'],
    ['понедельник', 'вторник', 'среда/среду', 'четверг', 'пятница/пятницу', 'суббота/субботу', 'воскресенье'])
_AR_DAYS = _table(['الاثنين/الإثنين', 'الثلاثاء', 'الأربعاء/الاربعاء', 'الخميس', 'الجمعة', 'السبت', 'الأحد/الاحد'])
_HE_DAYS = {'שני': 0, 'שלישי': 1, 'רביעי': 2, 'חמישי': 3, 'שישי': 4, 'שבת': 5, 'ראשון': 6}
_alt = lambda words: '|'.join(sorted(words, key=len, reverse=True))
_XMON = _alt(_XMONTHS); _XDAY = _alt(_XDAYS); _ARDAY = _alt(_AR_DAYS)

# "Today" and "tomorrow". Whole words where words are separated by spaces; Hebrew and Arabic attach prefixes, so no word edge there.
TODAY = (r"(?<!\w)(?:hoy|esta (?:mañana|manana|tarde|noche)|aujourd['’]hui|ce (?:matin|soir)|cet après-midi|heute|hoje|esta (?:manhã|noite)"
         r"|oggi|stasera|stamattina|stanotte|сегодня)(?!\w)|היום|הערב|הלילה|اليوم|الليلة")
TOMORROW = (r"(?<!\w)(?:(?<!esta )(?<!la )(?<!pasado )ma[ñn]ana|(?<!-)demain|(?<!guten )(?<!heute )(?<!am )morgen|amanh[ãa]|domani|завтра)(?!\w)"
            r"|מחר(?!תיים)|غدا|غداً|بكرة|بكره")

_DATE = re.compile(
    r"(?P<iso>\b(?P<iy>\d{4})-(?P<im>\d{2})-(?P<id>\d{2})\b)"
    r"|(?P<num>(?<![\d.:/])(?P<na>\d{1,2})(?P<ns>[/.])(?P<nb>\d{1,2})(?:(?P=ns)(?P<ny>\d{2,4}))?(?![\d:/]))"
    rf"|(?P<xwd>(?P<xwdn>(?<!\w)(?:{_XDAY})|(?:{_ARDAY}))(?!\w))"
    rf"|(?P<md>\b(?P<mdm>{_MON})[a-z]*\.?\s+(?P<mdd>\d{{1,2}})(?!\d|:))"
    rf"|(?P<dm>\b(?P<dmd>\d{{1,2}})(?:st|nd|rd|th)?\s+(?:of\s+)?(?P<dmm>{_MON})[a-z]*\b)"
    rf"|(?P<xm>(?<!\d)(?P<xmd>\d{{1,2}})(?:\.|º|er)?\s+(?:de\s+)?[בל]?(?P<xmm>{_XMON})(?!\w))"
    rf"|(?P<today>\b(?:today|tonight|this (?:morning|afternoon|evening))\b|{TODAY})"
    rf"|(?P<tomorrow>\b(?:tomorrow|tmrw)\b|{TOMORROW})"
    r"|(?P<wd>\b(?:this |next |on )?(?P<wdn>mon|tue|wed|thu|fri|sat|sun)[a-z]*day\b)"
    r"|(?P<hwd>יום (?P<hwdn>ראשון|שני|שלישי|רביעי|חמישי|שישי)|(?<![א-ת])ב?שבת(?![א-ת]))", re.I)
_TIME = re.compile(r"(?<![\d:.])(\d{1,2})(?::(\d{2}))?[\s\u202f\u00a0]?([ap])\.?m\b|(?<![\d:.])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])", re.I)

def _mk(y, m, d):
    try: return date(y, m, d)
    except ValueError: return None

def _near_year(sent, m, d):
    """A day and month without a year: the occurrence closest to when the message was sent."""
    c = [x for x in (_mk(sent.year + k, m, d) for k in (-1, 0, 1)) if x]
    return min(c, key=lambda x: abs((x - sent).days)) if c else None

def _dates(text, sent):
    out = []
    for m in _DATE.finditer(text):
        g = next(k for k in ('iso', 'num', 'xwd', 'md', 'dm', 'xm', 'today', 'tomorrow', 'wd', 'hwd') if m.group(k)); d = None
        if g == 'iso': d = _mk(int(m['iy']), int(m['im']), int(m['id']))
        elif g == 'num':
            a, b, y = int(m['na']), int(m['nb']), m['ny']
            if m['ns'] == '.' and not y and (len(m['na']) + len(m['nb']) < 3 or b > 12): continue   # "3.5" is a number, not a date
            if y:
                y = int(y) + (2000 if len(y) == 2 else 0); c = [x for x in (_mk(y, b, a), _mk(y, a, b)) if x]
            else: c = [x for x in (_near_year(sent, b, a), _near_year(sent, a, b)) if x]
            d = min(c, key=lambda x: abs((x - sent).days)) if c else None      # day-first or month-first: whichever is nearer
        elif g == 'md': d = _near_year(sent, _MONTHS[m['mdm'].lower()], int(m['mdd']))
        elif g == 'dm': d = _near_year(sent, _MONTHS[m['dmm'].lower()], int(m['dmd']))
        elif g == 'xm': d = _near_year(sent, _XMONTHS[m['xmm'].lower()], int(m['xmd']))
        elif g == 'today': d = sent
        elif g == 'tomorrow': d = sent + timedelta(days=1)
        elif g == 'wd': d = sent + timedelta(days=(_DAYS[m['wdn'].lower()] - sent.weekday()) % 7)
        elif g == 'xwd': d = sent + timedelta(days=({**_XDAYS, **_AR_DAYS}[m['xwdn'].lower()] - sent.weekday()) % 7)
        elif g == 'hwd': d = sent + timedelta(days=(_HE_DAYS.get(m['hwdn'], 5) - sent.weekday()) % 7)
        if d and abs((d - sent).days) < 400: out.append((m.start(), m.end(), d, g in ('today', 'tomorrow', 'wd', 'xwd', 'hwd')))
    return out

def _times(text):
    out = []
    for m in _TIME.finditer(text):
        if m.group(3):
            h = int(m.group(1)) % 12 + (12 if m.group(3).lower() == 'p' else 0); mi = int(m.group(2) or 0)
            if int(m.group(1)) > 12 or mi > 59: continue
        else: h, mi = int(m.group(4)), int(m.group(5))
        out.append((m.start(), m.end(), dtime(h, mi)))
    return out

NAMES = ['dl_dates', 'dl_times', 'dl_hours', 'dl_6h', 'dl_24h', 'dl_48h', 'dl_7d', 'dl_same_day', 'dl_next_day',
         'dl_relative', 'dl_time_today', 'dl_only_past', 'dl_early']
_CAP = 24 * 14

def features(text, sent_epoch):
    """Deadline features for `text` sent at `sent_epoch` (seconds). All zeros, with the hours at their cap, when nothing is found."""
    f = dict.fromkeys(NAMES, 0.0); f['dl_hours'] = math.log1p(_CAP)
    if not text or sent_epoch is None: return [f[k] for k in NAMES]
    tz = _tz(); sent = datetime.fromtimestamp(sent_epoch, tz); text = text[:4000]
    dates, times = _dates(text, sent.date()), _times(text)
    f['dl_dates'] = math.log1p(len(dates)); f['dl_times'] = math.log1p(len(times))
    ahead = []; used = set()
    for s, e, d, relative in dates:
        # The clock time written closest to this date, within a short distance, belongs to it.
        near = [(min(abs(ts - e), abs(s - te)), i, t) for i, (ts, te, t) in enumerate(times) if min(abs(ts - e), abs(s - te)) <= 40]
        if near: _, i, t = min(near); used.add(i); when = datetime.combine(d, t, tz); dated_time = True
        else: when = datetime.combine(d, dtime(23, 59), tz); dated_time = False       # a bare date lasts until the end of that day
        h = (when - sent).total_seconds() / 3600
        if d == sent.date(): f['dl_same_day'] = 1.0
        if d == sent.date() + timedelta(days=1): f['dl_next_day'] = 1.0
        if relative: f['dl_relative'] = 1.0
        if h >= -1: ahead.append(max(h, 0.0))
        if dated_time and 0 <= h <= 24 and sent.hour >= 18 and when.hour < 10: f['dl_early'] = 1.0   # tomorrow morning, said tonight
    # A clock time with no date nearby most likely means today, if it is still ahead.
    for i, (_, _, t) in enumerate(times):
        if i in used: continue
        h = (datetime.combine(sent.date(), t, tz) - sent).total_seconds() / 3600
        if 0 <= h <= 14: f['dl_time_today'] = 1.0
    if ahead:
        m = min(ahead); f['dl_hours'] = math.log1p(min(m, _CAP))
        f['dl_6h'], f['dl_24h'], f['dl_48h'], f['dl_7d'] = float(m <= 6), float(m <= 24), float(m <= 48), float(m <= 168)
    elif dates: f['dl_only_past'] = 1.0
    return [f[k] for k in NAMES]
