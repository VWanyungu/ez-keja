import type { LanguageCode } from '../../middlewares/auth.js';

/**
 * Notification text per event code, in the recipient's language (FR-LOC-001, SRS §10.2). The
 * in-app list and the email use the same text: the title is the subject line.
 *
 * Rules: a missing language falls back to English and an unknown event code to a generic line, so
 * a raw key never reaches a user. Payloads hold ids and public names only (design §5.5); every value
 * is read defensively because earlier phases wrote payloads of different shapes.
 *
 * NEEDS NATIVE REVIEW: the Kiswahili strings below were written without a native speaker. Have one
 * check tone, spelling and the real-estate terms before launch.
 */
export type Payload = Record<string, unknown>;
export interface RenderedNotification {
  title: string;
  body: string;
}

type Lang = LanguageCode;
type Template = (p: Payload, lang: Lang) => RenderedNotification;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

const building = (p: Payload, lang: Lang): string => str(p.buildingName) ?? (lang === 'sw' ? 'jengo' : 'a building');
const spaceType = (p: Payload, lang: Lang): string => str(p.spaceTypeName) ?? (lang === 'sw' ? 'nafasi' : 'a space');
/** "Space at Building" / "Nafasi katika Building". */
const where = (p: Payload, lang: Lang): string =>
  lang === 'sw' ? `${spaceType(p, lang)} katika ${building(p, lang)}` : `${spaceType(p, lang)} at ${building(p, lang)}`;
const reasonLine = (p: Payload, lang: Lang): string => {
  const reason = str(p.reason);
  return reason ? (lang === 'sw' ? ` Sababu: ${reason}` : ` Reason: ${reason}`) : '';
};

/** Kenya has no daylight saving, so a fixed +3 h is exact: "2026-12-01 10:00 (EAT)". */
export function formatEat(iso: unknown): string | null {
  const ms = typeof iso === 'string' ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(ms)) return null;
  return `${new Date(ms + 3 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')} (EAT)`;
}

const generic: Record<Lang, RenderedNotification> = {
  en: { title: 'You have a new notification', body: 'Open the app to see the details.' },
  sw: { title: 'Una arifa mpya', body: 'Fungua programu kuona maelezo.' },
};

const decisionTemplate =
  (en: { yes: string; no: string }, sw: { yes: string; no: string }): Template =>
  (p, lang) => {
    const approved = p.decision === 'approved';
    const b = p.subjectType === 'building' || p.buildingName ? building(p, lang) : '';
    const title = (lang === 'sw' ? sw : en)[approved ? 'yes' : 'no'].replace('{b}', b);
    return { title, body: `${title}.${approved ? '' : reasonLine(p, lang)}` };
  };

const TEMPLATES: Record<string, Template> = {
  // N-01 / N-02: verification decisions (Phase 8).
  'N-01': decisionTemplate(
    { yes: 'Your account has been verified', no: 'Your account verification was not approved' },
    { yes: 'Akaunti yako imethibitishwa', no: 'Uthibitisho wa akaunti yako haukukubaliwa' },
  ),
  'N-02': decisionTemplate(
    { yes: '{b} has been verified', no: 'Verification of {b} was not approved' },
    { yes: '{b} imethibitishwa', no: 'Uthibitisho wa {b} haukukubaliwa' },
  ),

  // N-03: verification revoked or reopened (Phase 8).
  'N-03': (p, lang) => {
    const isBuilding = p.subjectType === 'building';
    const reopened = p.kind === 'reopened';
    const b = building(p, lang);
    let title: string;
    if (lang === 'sw') {
      title = reopened
        ? isBuilding ? `Uthibitisho wa ${b} unapitiwa upya` : 'Uthibitisho wa akaunti unapitiwa upya'
        : isBuilding ? `Uthibitisho wa ${b} umeondolewa` : 'Uthibitisho wa akaunti yako umeondolewa';
    } else {
      title = reopened
        ? isBuilding ? `Verification of ${b} is being reviewed again` : 'Account verification is being reviewed again'
        : isBuilding ? `Verification of ${b} was revoked` : 'Your account verification was revoked';
    }
    return { title, body: `${title}.${reasonLine(p, lang)}` };
  },

  // N-04: update reminder (Phase 6). One combined message per lister.
  'N-04': (p, lang) => {
    const items = Array.isArray(p.spaceTypes) ? (p.spaceTypes as Payload[]) : [];
    const count = typeof p.count === 'number' ? p.count : items.length;
    const list = items
      .slice(0, 10)
      .map((i) => `- ${where({ ...i, spaceTypeName: i.name }, lang)}`) // the reminder payload calls it `name`
      .join('\n');
    if (lang === 'sw') {
      return {
        title: 'Thibitisha upatikanaji wa nafasi zako',
        body: `Nafasi ${count} zinahitaji kuthibitishwa ili zisionekane kuwa zimepitwa na wakati.${list ? `\n${list}` : ''}`,
      };
    }
    return {
      title: 'Please confirm your vacant spaces',
      body: `${count} space type${count === 1 ? ' needs' : 's need'} confirming so ${count === 1 ? 'it does' : 'they do'} not show as possibly out of date.${list ? `\n${list}` : ''}`,
    };
  },

  // N-05 / N-06: enquiry thread.
  'N-05': (p, lang) =>
    lang === 'sw'
      ? { title: `Ujumbe mpya kuhusu ${where(p, lang)}`, body: `Mteja ameandika kuhusu ${where(p, lang)}. Fungua mazungumzo ujibu.` }
      : { title: `New message about ${where(p, lang)}`, body: `A client wrote to you about ${where(p, lang)}. Open the conversation to reply.` },
  'N-06': (p, lang) =>
    lang === 'sw'
      ? { title: `Umejibiwa kuhusu ${where(p, lang)}`, body: `Mwenye jengo amejibu ujumbe wako kuhusu ${where(p, lang)}.` }
      : { title: `New reply about ${where(p, lang)}`, body: `The building's contact replied to your message about ${where(p, lang)}.` },

  // N-07: viewing request and responses.
  'N-07': (p, lang) => {
    const w = where(p, lang);
    const time = formatEat(p.proposedFor);
    const kind = typeof p.kind === 'string' ? p.kind : '';
    const en: Record<string, string> = {
      requested: `New viewing request for ${w}${time ? `, ${time}` : ''}`,
      accepted: `Your viewing of ${w} is confirmed${time ? ` for ${time}` : ''}`,
      declined: `Your viewing request for ${w} was declined`,
      counter_proposed: `A different viewing time was proposed for ${w}${time ? `: ${time}` : ''}`,
      counter_accepted: `The client accepted the new viewing time for ${w}${time ? `: ${time}` : ''}`,
      counter_declined: `The client declined the new viewing time for ${w}; the request is cancelled`,
      cancelled: `The viewing request for ${w} was cancelled`,
    };
    const sw: Record<string, string> = {
      requested: `Ombi jipya la kutazama ${w}${time ? `, ${time}` : ''}`,
      accepted: `Ombi lako la kutazama ${w} limekubaliwa${time ? ` kwa ${time}` : ''}`,
      declined: `Ombi lako la kutazama ${w} limekataliwa`,
      counter_proposed: `Muda mwingine wa kutazama ${w} umependekezwa${time ? `: ${time}` : ''}`,
      counter_accepted: `Mteja amekubali muda mpya wa kutazama ${w}${time ? `: ${time}` : ''}`,
      counter_declined: `Mteja amekataa muda mpya wa kutazama ${w}; ombi limefutwa`,
      cancelled: `Ombi la kutazama ${w} limefutwa`,
    };
    const title = (lang === 'sw' ? sw : en)[kind] ?? (lang === 'sw' ? `Ombi la kutazama ${w}` : `Viewing request for ${w}`);
    return { title, body: `${title}.` };
  },

  // N-08: the space type is Fully let or was removed (FR-AVL-009).
  'N-08': (p, lang) => {
    const removed = p.reason === 'space_type_removed';
    const w = where(p, lang);
    if (lang === 'sw') {
      return {
        title: removed ? `${w} haipatikani tena` : `${w} imejaa`,
        body: `${removed ? `${w} imeondolewa.` : `${w} haina nafasi tena.`} Mazungumzo na maombi ya kutazama yaliyokuwa wazi yamefungwa.`,
      };
    }
    return {
      title: removed ? `${w} is no longer listed` : `${w} is now fully let`,
      body: `${removed ? `${w} was removed.` : `${w} has no vacant spaces left.`} Your open conversation and viewing requests about it have been closed.`,
    };
  },

  // N-09: a client reported a building or space type. The comment is never included (OQ-50).
  'N-09': (p, lang) => {
    const target = p.spaceTypeName ? where(p, lang) : building(p, lang);
    const reasons: Record<Lang, Record<string, string>> = {
      en: { unavailable: 'was reported as unavailable', inaccurate: 'was reported as inaccurate', suspicious: 'was reported as suspicious' },
      sw: {
        unavailable: 'imeripotiwa kuwa haipatikani',
        inaccurate: 'imeripotiwa kuwa na taarifa zisizo sahihi',
        suspicious: 'imeripotiwa kuwa na mashaka',
      },
    };
    const reason = reasons[lang][typeof p.reason === 'string' ? p.reason : ''] ?? (lang === 'sw' ? 'imeripotiwa' : 'was reported');
    return { title: lang === 'sw' ? `Ripoti kuhusu ${target}` : `Report about ${target}`, body: `${target} ${reason}.` };
  },

  // N-10: moderation by an Admin (FR-ADM-003): suspension, reinstatement or photo removal (Phase 10).
  // payload: { subject: 'account' | 'building' | 'photo', action: 'suspended' | 'reinstated' | 'removed',
  //            buildingName?, reason?, buildingsAffected?, buildingsRestored? }
  'N-10': (p, lang) => {
    const subject = p.subject === 'building' || p.subject === 'photo' ? p.subject : 'account';
    const reinstated = p.action === 'reinstated';
    const b = building(p, lang);
    const count = (v: unknown): number => (typeof v === 'number' && v > 0 ? v : 0);
    const affected = count(p.buildingsAffected);
    const restored = count(p.buildingsRestored);
    let title: string;
    let extra = '';
    if (lang === 'sw') {
      title =
        subject === 'photo'
          ? `Picha ya ${b} imeondolewa`
          : subject === 'building'
            ? reinstated ? `${b} imerejeshwa` : `${b} imesimamishwa`
            : reinstated ? 'Akaunti yako imerejeshwa' : 'Akaunti yako imesimamishwa';
      if (subject === 'account' && affected) {
        extra = affected === 1 ? ' Jengo 1 unalolisimamia pia limesimamishwa.' : ` Majengo ${affected} unayoyasimamia pia yamesimamishwa.`;
      }
      if (subject === 'account' && restored) extra = restored === 1 ? ' Jengo 1 limerejeshwa.' : ` Majengo ${restored} yamerejeshwa.`;
    } else {
      title =
        subject === 'photo'
          ? `A photo of ${b} was removed`
          : subject === 'building'
            ? reinstated ? `${b} has been reinstated` : `${b} has been suspended`
            : reinstated ? 'Your account has been reinstated' : 'Your account has been suspended';
      if (subject === 'account' && affected) extra = ` ${affected} building${affected === 1 ? '' : 's'} you maintain ${affected === 1 ? 'was' : 'were'} also suspended.`;
      if (subject === 'account' && restored) extra = ` ${restored} building${restored === 1 ? ' was' : 's were'} restored.`;
    }
    return { title, body: `${title}.${extra}${reinstated ? '' : reasonLine(p, lang)}` };
  },

  // N-11: Maps quota (Admin).
  'N-11': (p, lang) => {
    const over = p.threshold === 100;
    const used = typeof p.used === 'number' ? p.used : null;
    const limit = typeof p.limit === 'number' ? p.limit : null;
    const counts = used !== null && limit !== null ? ` (${used}/${limit})` : '';
    return lang === 'sw'
      ? {
          title: over ? 'Kikomo cha kila siku cha Maps kimefikiwa' : 'Matumizi ya Maps yamefikia 80%',
          body: `Matumizi ya Google Maps leo${counts}. ${over ? 'Taarifa za safari zitaonyesha "hazipatikani" hadi saa 00:00 UTC.' : 'Kikomo kikifikiwa, taarifa za safari hazitapatikana.'}`,
        }
      : {
          title: over ? 'Daily Maps limit reached' : 'Maps usage at 80% of the daily limit',
          body: `Google Maps usage today${counts}. ${over ? 'Commute answers show "unavailable" until 00:00 UTC.' : 'When the limit is reached, commute answers are unavailable.'}`,
        };
  },

  // N-12: data subject requests (Phase 11, FR-PRV-002).
  // payload: { kind: 'received' | 'acknowledged' | 'completed' | 'rejected' | 'deletion_completed',
  //            requestType: 'access' | 'correction' | 'export' | 'deletion', reason?, exportDays? }
  // `received` goes to every Admin, `acknowledged`/`completed`/`rejected` to the requester.
  // `deletion_completed` is only ever sent as an e-mail straight to the requester's real address
  // before the erasure replaces it (design §10.6 step 10); it is never stored as a notification row.
  'N-12': (p, lang) => {
    const labels: Record<Lang, Record<string, string>> = {
      en: {
        access: 'access to your data',
        correction: 'correction of your data',
        export: 'a copy of your data',
        deletion: 'deletion of your data',
      },
      sw: {
        access: 'kupata data yako',
        correction: 'marekebisho ya data yako',
        export: 'nakala ya data yako',
        deletion: 'kufutwa kwa data yako',
      },
    };
    // The Admin copy speaks about the user ("their data"), the requester copy about "your data".
    const theirs: Record<Lang, Record<string, string>> = {
      en: { access: 'access to their data', correction: 'correction of their data', export: 'a copy of their data', deletion: 'deletion of their data' },
      sw: { access: 'kupata data zao', correction: 'marekebisho ya data zao', export: 'nakala ya data zao', deletion: 'kufutwa kwa data zao' },
    };
    const type = typeof p.requestType === 'string' ? p.requestType : '';
    const kind = typeof p.kind === 'string' ? p.kind : '';
    const label = (kind === 'received' ? theirs : labels)[lang][type] ?? (kind === 'received' ? (lang === 'sw' ? 'data zao' : 'their data') : lang === 'sw' ? 'data yako' : 'your data');
    const days = typeof p.exportDays === 'number' && p.exportDays > 0 ? p.exportDays : 0;
    const download = type === 'export' || type === 'access';
    if (lang === 'sw') {
      if (kind === 'received') {
        return { title: 'Ombi jipya la data', body: `Mtumiaji ameomba ${label}. Fungua orodha ya maombi ya Msimamizi kulishughulikia.` };
      }
      if (kind === 'completed') {
        const extra = download && days ? ` Unaweza kupakua data yako kutoka kwenye akaunti yako kwa siku ${days}.` : '';
        return { title: 'Ombi lako la data limekamilika', body: `Ombi lako la ${label} limekamilika.${extra}` };
      }
      if (kind === 'rejected') {
        return { title: 'Ombi lako la data halikukubaliwa', body: `Ombi lako la ${label} halikukubaliwa.${reasonLine(p, lang)}` };
      }
      if (kind === 'deletion_completed') {
        return {
          title: 'Data zako binafsi zimefutwa',
          body:
            'Kama ulivyoomba, data zako binafsi zimefutwa na akaunti yako haiwezi tena kutumika kuingia.\n' +
            'Rekodi zinazopaswa kuhifadhiwa (kama kumbukumbu za ukaguzi, ujumbe wa maulizo na maombi ya kutazama) zinabaki bila jina lako.',
        };
      }
      return { title: 'Tumepokea ombi lako la data', body: `Ombi lako la ${label} limepokelewa. Msimamizi atalishughulikia na utaarifiwa matokeo.` };
    }
    if (kind === 'received') {
      return { title: 'New data request', body: `A user asked for ${label}. Open the Admin request queue to handle it.` };
    }
    if (kind === 'completed') {
      const extra = download && days ? ` You can download your data from your account for ${days} day${days === 1 ? '' : 's'}.` : '';
      return { title: 'Your data request was completed', body: `Your request for ${label} was completed.${extra}` };
    }
    if (kind === 'rejected') {
      return { title: 'Your data request was not approved', body: `Your request for ${label} was not approved.${reasonLine(p, lang)}` };
    }
    if (kind === 'deletion_completed') {
      return {
        title: 'Your personal data has been erased',
        body:
          'As you asked, your personal data has been erased and your account can no longer be used to sign in.\n' +
          'Records that must be kept (such as the audit log, enquiry messages and viewing requests) remain without your name.',
      };
    }
    return { title: 'We received your data request', body: `Your request for ${label} was received. An Admin will handle it and you will be told the outcome.` };
  },

  // N-13: the lister was verified and their building can now be confirmed and published.
  'N-13': (p, lang) =>
    lang === 'sw'
      ? { title: `${building(p, lang)} iko tayari kuchapishwa`, body: `Akaunti yako imethibitishwa. Thibitisha na uchapishe ${building(p, lang)}.` }
      : { title: `${building(p, lang)} is ready to publish`, body: `Your account is verified. Confirm and publish ${building(p, lang)}.` },
};

export function renderNotification(eventCode: string, payload: unknown, language: string | null | undefined): RenderedNotification {
  const lang: Lang = language === 'sw' ? 'sw' : 'en';
  const p: Payload = typeof payload === 'object' && payload !== null && !Array.isArray(payload) ? (payload as Payload) : {};
  const template = TEMPLATES[eventCode];
  if (!template) return generic[lang];
  try {
    return template(p, lang);
  } catch {
    // A payload of an unexpected shape must not break the list or the delivery run.
    return generic[lang];
  }
}

const escapeHtml = (value: string): string =>
  value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');

/** Subject, plain-text and HTML bodies for the email. All user-supplied text is escaped. */
export function renderEmail(rendered: RenderedNotification): { subject: string; text: string; html: string } {
  const paragraphs = rendered.body.split('\n').filter((line) => line.trim() !== '');
  return {
    subject: rendered.title,
    text: rendered.body,
    html: `<p><strong>${escapeHtml(rendered.title)}</strong></p>${paragraphs.map((l) => `<p>${escapeHtml(l)}</p>`).join('')}`,
  };
}
