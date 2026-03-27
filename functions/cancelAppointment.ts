import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

// Cancels an appointment and optionally deletes the Google Calendar event

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    const { appointment_id, access_token, delete_from_calendar = true } = body;

    if (!appointment_id) {
      return Response.json({ error: 'Missing required field: appointment_id' }, { status: 400 });
    }

    const db = base44.asServiceRole.entities;

    // Get the appointment
    const appointments = await db.Appointment.filter({ id: appointment_id });
    if (!appointments.length) {
      return Response.json({ error: 'Appointment not found' }, { status: 404 });
    }
    const appointment = appointments[0];

    if (appointment.status === 'cancelled') {
      return Response.json({ error: 'Appointment is already cancelled' }, { status: 400 });
    }

    // Get business config for Google Calendar
    if (delete_from_calendar && appointment.google_event_id) {
      try {
        const configs = await db.BusinessConfig.filter({ email: appointment.business_email });
        const config = configs[0];
        const token = access_token || (config?.google_refresh_token ? await refreshGoogleToken(config.google_refresh_token) : null);

        if (token) {
          const calendarId = config?.calendar_id || 'primary';
          await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${appointment.google_event_id}`,
            {
              method: 'DELETE',
              headers: { Authorization: `Bearer ${token}` },
            }
          );
        }
      } catch (e) {
        console.error('Google Calendar delete error:', e.message);
      }
    }

    // Update appointment status
    await db.Appointment.update(appointment_id, { status: 'cancelled' });

    return Response.json({ success: true, appointment_id, status: 'cancelled' });
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
