import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

// Books an appointment for a business and creates a Google Calendar event

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    const {
      business_email,
      client_name,
      client_email,
      client_phone,
      start_datetime,
      title,
      notes,
      booked_via,
      access_token, // Google Calendar access token passed from host app
    } = body;

    if (!business_email || !start_datetime || !client_name) {
      return Response.json({ error: 'Missing required fields: business_email, start_datetime, client_name' }, { status: 400 });
    }

    const db = base44.asServiceRole.entities;

    // Get business config
    const configs = await db.BusinessConfig.filter({ email: business_email });
    if (!configs.length) {
      return Response.json({ error: 'Business not found' }, { status: 404 });
    }
    const config = configs[0];

    const durationMin = config.appointment_duration_minutes || 60;
    const start = new Date(start_datetime);
    const end = new Date(start.getTime() + durationMin * 60000);

    // Check slot is still available
    const existing = await db.Appointment.filter({ business_email });
    const conflict = existing.some((a: any) => {
      if (a.status === 'cancelled') return false;
      const aStart = new Date(a.start_datetime);
      const aEnd = new Date(a.end_datetime);
      return start < aEnd && end > aStart;
    });

    if (conflict) {
      return Response.json({ error: 'Time slot is no longer available' }, { status: 409 });
    }

    let googleEventId = null;

    // Create Google Calendar event if access token provided
    if (access_token || config.google_refresh_token) {
      try {
        const calendarId = config.calendar_id || 'primary';
        const token = access_token || await refreshGoogleToken(config.google_refresh_token);

        const event = {
          summary: title || `פגישה עם ${client_name}`,
          description: notes || '',
          start: { dateTime: start.toISOString(), timeZone: config.timezone || 'Asia/Jerusalem' },
          end: { dateTime: end.toISOString(), timeZone: config.timezone || 'Asia/Jerusalem' },
          attendees: client_email ? [{ email: client_email }] : [],
        };

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
        // Log but don't fail — save appointment even if Google Calendar fails
        console.error('Google Calendar error:', e.message);
      }
    }

    // Save appointment to DB
    const appointment = await db.Appointment.create({
      business_email,
      client_name,
      client_email: client_email || '',
      client_phone: client_phone || '',
      start_datetime: start.toISOString(),
      end_datetime: end.toISOString(),
      title: title || `פגישה עם ${client_name}`,
      notes: notes || '',
      status: 'confirmed',
      google_event_id: googleEventId,
      booked_via: booked_via || 'api',
      reminder_sent: false,
    });

    return Response.json({ success: true, appointment, google_event_id: googleEventId });
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
