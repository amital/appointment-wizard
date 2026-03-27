import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

// Reschedules an appointment to a new time slot

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    const { appointment_id, new_start_datetime, access_token } = body;

    if (!appointment_id || !new_start_datetime) {
      return Response.json({ error: 'Missing required fields: appointment_id, new_start_datetime' }, { status: 400 });
    }

    const db = base44.asServiceRole.entities;

    // Get appointment
    const appointments = await db.Appointment.filter({ id: appointment_id });
    if (!appointments.length) {
      return Response.json({ error: 'Appointment not found' }, { status: 404 });
    }
    const appointment = appointments[0];

    if (appointment.status === 'cancelled') {
      return Response.json({ error: 'Cannot reschedule a cancelled appointment' }, { status: 400 });
    }

    // Get business config
    const configs = await db.BusinessConfig.filter({ email: appointment.business_email });
    const config = configs[0];
    const durationMin = config?.appointment_duration_minutes || 60;

    const newStart = new Date(new_start_datetime);
    const newEnd = new Date(newStart.getTime() + durationMin * 60000);

    // Check new slot is available (excluding current appointment)
    const existing = await db.Appointment.filter({ business_email: appointment.business_email });
    const conflict = existing.some((a: any) => {
      if (a.id === appointment_id) return false;
      if (a.status === 'cancelled') return false;
      const aStart = new Date(a.start_datetime);
      const aEnd = new Date(a.end_datetime);
      return newStart < aEnd && newEnd > aStart;
    });

    if (conflict) {
      return Response.json({ error: 'New time slot is not available' }, { status: 409 });
    }

    // Update Google Calendar event if exists
    if (appointment.google_event_id) {
      try {
        const token = access_token || (config?.google_refresh_token ? await refreshGoogleToken(config.google_refresh_token) : null);
        if (token) {
          const calendarId = config?.calendar_id || 'primary';
          const tz = config?.timezone || 'Asia/Jerusalem';

          await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${appointment.google_event_id}`,
            {
              method: 'PATCH',
              headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                start: { dateTime: newStart.toISOString(), timeZone: tz },
                end: { dateTime: newEnd.toISOString(), timeZone: tz },
              }),
            }
          );
        }
      } catch (e) {
        console.error('Google Calendar update error:', e.message);
      }
    }

    // Update appointment in DB
    await db.Appointment.update(appointment_id, {
      start_datetime: newStart.toISOString(),
      end_datetime: newEnd.toISOString(),
      status: 'confirmed',
    });

    return Response.json({
      success: true,
      appointment_id,
      new_start: newStart.toISOString(),
      new_end: newEnd.toISOString(),
    });
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
