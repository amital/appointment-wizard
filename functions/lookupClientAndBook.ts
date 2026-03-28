import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

// lookupClientAndBook
// Looks up a client by name in a specified Base44 app (e.g. AppScout),
// retrieves their details (email, phone), then books an appointment.
//
// Input:
//   business_email    string  required  — which business calendar to book on
//   client_name       string  required  — name to search for (partial match OK)
//   start_datetime    string  required  — ISO 8601 appointment start time
//   source_app_id     string  optional  — Base44 app ID to look up client in (default: searches BusinessConfig contacts)
//   source_entity     string  optional  — entity name to search in (default: "Customer" then "Lead")
//   title             string  optional  — appointment title
//   notes             string  optional  — appointment notes
//   access_token      string  optional  — Google OAuth token for calendar writes
//
// Output:
//   success           boolean
//   client_found      boolean
//   client            object  — the matched client record (name, email, phone)
//   appointment       object  — the created appointment (if booked)
//   google_event_id   string
//   error             string  — if client not found or slot unavailable

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    const {
      business_email,
      client_name,
      start_datetime,
      source_app_id,
      source_entity,
      title,
      notes,
      access_token,
    } = body;

    if (!business_email || !client_name || !start_datetime) {
      return Response.json({
        error: 'Missing required fields: business_email, client_name, start_datetime',
      }, { status: 400 });
    }

    const db = base44.asServiceRole.entities;

    // --- Step 1: Get business config ---
    const configs = await db.BusinessConfig.filter({ email: business_email });
    if (!configs.length) {
      return Response.json({ error: 'Business not found' }, { status: 404 });
    }
    const config = configs[0];
    const tz = config.timezone || 'Asia/Jerusalem';
    const durationMin = config.appointment_duration_minutes || 60;

    // --- Step 2: Look up client ---
    let clientRecord: any = null;
    let searchError: string | null = null;

    const entitiesToSearch = source_entity
      ? [source_entity]
      : ['Customer', 'Lead', 'Contact', 'client']; // try common entity names

    if (source_app_id) {
      // Search in external Base44 app
      try {
        const externalBase44Url = `https://api.base44.com/api/apps/${source_app_id}/entities`;

        // Try each entity until we find a match
        for (const entityName of entitiesToSearch) {
          try {
            const searchRes = await fetch(`${externalBase44Url}/${entityName}/filter`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                // Forward the auth token from the incoming request
                'Authorization': req.headers.get('Authorization') || '',
              },
              body: JSON.stringify({}), // get all, filter client-side for partial name match
            });

            if (!searchRes.ok) continue;

            const data = await searchRes.json();
            const records = Array.isArray(data) ? data : (data.records || data.items || []);

            // Partial name match (case-insensitive)
            const nameField = ['full_name', 'name', 'client_name', 'contact_name'];
            const match = records.find((r: any) =>
              nameField.some(f =>
                r[f] && r[f].toLowerCase().includes(client_name.toLowerCase())
              )
            );

            if (match) {
              // Normalize the client record
              clientRecord = {
                id: match.id,
                name: match.full_name || match.name || match.client_name || match.contact_name || client_name,
                email: match.email || match.client_email || match.contact_email || null,
                phone: match.phone || match.client_phone || match.contact_phone || match.phone_number || null,
                source_entity: entityName,
                source_app_id,
                raw: match,
              };
              break;
            }
          } catch (e) {
            // Entity doesn't exist in this app, try next
            continue;
          }
        }

        if (!clientRecord) {
          searchError = `Client "${client_name}" not found in app ${source_app_id} (searched: ${entitiesToSearch.join(', ')})`;
        }
      } catch (e) {
        searchError = `Failed to search external app: ${e.message}`;
      }
    } else {
      // No external app — use the name as-is (client details unknown)
      clientRecord = {
        name: client_name,
        email: null,
        phone: null,
        source_entity: null,
        source_app_id: null,
      };
    }

    // --- Step 3: If client not found in external app, return error ---
    if (!clientRecord && searchError) {
      return Response.json({
        success: false,
        client_found: false,
        error: searchError,
        hint: 'Provide source_app_id and make sure the client exists in a Customer or Lead entity',
      }, { status: 404 });
    }

    // --- Step 4: Check slot availability ---
    const start = new Date(start_datetime);
    const end = new Date(start.getTime() + durationMin * 60000);

    const existing = await db.Appointment.filter({ business_email });
    const conflict = existing.some((a: any) => {
      if (a.status === 'cancelled') return false;
      const aStart = new Date(a.start_datetime);
      const aEnd = new Date(a.end_datetime);
      return start < aEnd && end > aStart;
    });

    if (conflict) {
      return Response.json({
        success: false,
        client_found: true,
        client: clientRecord,
        error: 'Time slot is not available — conflict with existing appointment',
      }, { status: 409 });
    }

    // Also check blocked slots
    const blockedSlots = await db.BlockedSlot.filter({ business_email });
    const isBlocked = blockedSlots.some((b: any) => {
      return start < new Date(b.end_datetime) && end > new Date(b.start_datetime);
    });

    if (isBlocked) {
      return Response.json({
        success: false,
        client_found: true,
        client: clientRecord,
        error: 'Time slot is blocked',
      }, { status: 409 });
    }

    // --- Step 5: Create Google Calendar event ---
    let googleEventId = null;
    if (access_token || config.google_refresh_token) {
      try {
        const token = access_token || await refreshGoogleToken(config.google_refresh_token);
        const calendarId = config.calendar_id || 'primary';
        const event = {
          summary: title || `פגישה עם ${clientRecord.name}`,
          description: [
            notes || '',
            clientRecord.phone ? `טלפון: ${clientRecord.phone}` : '',
            clientRecord.source_app_id ? `מקור: ${clientRecord.source_entity} / ${clientRecord.source_app_id}` : '',
          ].filter(Boolean).join('\n'),
          start: { dateTime: start.toISOString(), timeZone: tz },
          end: { dateTime: end.toISOString(), timeZone: tz },
          attendees: clientRecord.email ? [{ email: clientRecord.email }] : [],
        };

        const gcalRes = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
          {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(event),
          }
        );
        if (gcalRes.ok) googleEventId = (await gcalRes.json()).id;
      } catch (e) {
        console.error('GCal error:', e.message);
      }
    }

    // --- Step 6: Save appointment ---
    const appointment = await db.Appointment.create({
      business_email,
      client_name: clientRecord.name,
      client_email: clientRecord.email || '',
      client_phone: clientRecord.phone || '',
      start_datetime: start.toISOString(),
      end_datetime: end.toISOString(),
      title: title || `פגישה עם ${clientRecord.name}`,
      notes: notes || '',
      status: 'confirmed',
      google_event_id: googleEventId,
      booked_via: source_app_id ? `lookup:${source_app_id}` : 'lookup',
      reminder_sent: false,
    });

    return Response.json({
      success: true,
      client_found: true,
      client: clientRecord,
      appointment,
      google_event_id: googleEventId,
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
