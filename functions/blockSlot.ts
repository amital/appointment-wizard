import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

// Blocks a time slot for a business (vacation, out of office, etc.)
// Optionally creates a Google Calendar event to reflect the block

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    const {
      business_email,
      start_datetime,
      end_datetime,
      reason,
      is_recurring = false,
      recurrence_rule,
      access_token,
      create_calendar_event = true,
    } = body;

    if (!business_email || !start_datetime || !end_datetime) {
      return Response.json({ error: 'Missing required fields: business_email, start_datetime, end_datetime' }, { status: 400 });
    }

    const db = base44.asServiceRole.entities;

    const configs = await db.BusinessConfig.filter({ email: business_email });
    const config = configs[0];

    let googleEventId = null;

    // Create blocking event in Google Calendar
    if (create_calendar_event && (access_token || config?.google_refresh_token)) {
      try {
        const token = access_token || await refreshGoogleToken(config.google_refresh_token);
        const calendarId = config?.calendar_id || 'primary';
        const tz = config?.timezone || 'Asia/Jerusalem';

        const event: any = {
          summary: reason || 'חסום — לא זמין',
          start: { dateTime: new Date(start_datetime).toISOString(), timeZone: tz },
          end: { dateTime: new Date(end_datetime).toISOString(), timeZone: tz },
          transparency: 'opaque',
        };

        if (is_recurring && recurrence_rule) {
          event.recurrence = [recurrence_rule];
        }

        const gcalRes = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(event),
          }
        );

        if (gcalRes.ok) {
          const gcalEvent = await gcalRes.json();
          googleEventId = gcalEvent.id;
        }
      } catch (e) {
        console.error('Google Calendar error:', e.message);
      }
    }

    // Save blocked slot to DB
    const blocked = await db.BlockedSlot.create({
      business_email,
      start_datetime: new Date(start_datetime).toISOString(),
      end_datetime: new Date(end_datetime).toISOString(),
      reason: reason || '',
      is_recurring,
      recurrence_rule: recurrence_rule || '',
      google_event_id: googleEventId,
    });

    return Response.json({ success: true, blocked, google_event_id: googleEventId });
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});

async function refreshGoogleToken(refreshToken: string): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: Deno.env.get('GOOGLE_CLIENT_ID') || '',
      client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET') || '',
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json();
  return data.access_token;
}
