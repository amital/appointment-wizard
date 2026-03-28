import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

// processNaturalLanguage
// Accepts a free-text command in Hebrew or English and uses AI to:
//   - Block time slots (e.g. "ביום רביעי אני לא זמין בין 8 ל-12")
//   - Book appointments (e.g. "קבע פגישה עם דוד לוי ביום חמישי ב-14:00")
//   - Query availability (e.g. "מה הזמינות שלי השבוע?")
//   - Multiple actions in one command
//
// Input:
//   business_email  string  required  — which business calendar to act on
//   command         string  required  — free text in any language
//   access_token    string  optional  — Google OAuth token for calendar writes
//   timezone        string  optional  — override business timezone (default: Asia/Jerusalem)
//
// Output:
//   success         boolean
//   actions_taken   array   — list of actions the AI decided to perform
//   results         array   — result of each action
//   ai_summary      string  — human-readable summary of what was done

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    const { business_email, command, access_token, timezone } = body;

    if (!business_email || !command) {
      return Response.json({ error: 'Missing required fields: business_email, command' }, { status: 400 });
    }

    const db = base44.asServiceRole.entities;

    // Get business config
    const configs = await db.BusinessConfig.filter({ email: business_email });
    if (!configs.length) {
      return Response.json({ error: 'Business not found' }, { status: 404 });
    }
    const config = configs[0];
    const tz = timezone || config.timezone || 'Asia/Jerusalem';

    // Current date/time in business timezone
    const now = new Date();
    const nowStr = now.toLocaleString('he-IL', { timeZone: tz, dateStyle: 'full', timeStyle: 'short' });
    const todayISO = now.toISOString().split('T')[0];

    // --- Step 1: Ask AI to parse the command into structured actions ---
    const openaiKey = Deno.env.get('OPENAI_API_KEY');
    if (!openaiKey) {
      return Response.json({ error: 'OPENAI_API_KEY not configured' }, { status: 500 });
    }

    const parsePrompt = `
You are a calendar assistant. Parse the following natural language command into structured calendar actions.

Current date and time: ${nowStr} (timezone: ${tz})
Today's ISO date: ${todayISO}
Business email: ${business_email}
Business working hours: ${config.working_hours_start || '08:00'} - ${config.working_hours_end || '17:00'}
Working days: ${(config.working_days || [0,1,2,3,4]).map((d: number) => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]).join(', ')}
Appointment duration: ${config.appointment_duration_minutes || 60} minutes

Command: "${command}"

Parse this into one or more actions. Return a JSON object with:
{
  "actions": [
    {
      "type": "block_slot" | "book_appointment" | "query_availability" | "cancel_appointment",
      "params": { ... action-specific params ... }
    }
  ],
  "interpretation": "brief explanation of what you understood"
}

For "block_slot" params:
  start_datetime: ISO 8601 (compute from relative expressions like "ביום רביעי הקרוב")
  end_datetime: ISO 8601
  reason: string (from command or default "לא זמין")
  is_recurring: boolean

For "book_appointment" params:
  client_name: string (extract from command)
  client_email: string or null
  client_phone: string or null
  start_datetime: ISO 8601
  title: string (from command or default)
  notes: string

For "query_availability" params:
  date_from: ISO date YYYY-MM-DD
  date_to: ISO date YYYY-MM-DD

For "cancel_appointment" params:
  appointment_id: string (if mentioned) or null
  client_name: string (if mentioned, to find the appointment)
  approximate_datetime: ISO 8601 (if mentioned)

Important rules:
- "ביום רביעי הקרוב" = next Wednesday from today
- "מחר" = tomorrow
- "השבוע" = this week (from today to Sunday)
- "בין 8 ל-12" = 08:00 to 12:00
- "משעה אחת עד שתיים" = 13:00 to 14:00 (Israeli convention: afternoon unless specified)
- If a single time is given for booking, use it as start_datetime
- Always return valid ISO 8601 datetimes with the correct date computed from today (${todayISO})
- Return ONLY valid JSON, no markdown, no explanation outside the JSON
`;

    const aiParseRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: parsePrompt }],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      }),
    });

    if (!aiParseRes.ok) {
      const err = await aiParseRes.text();
      return Response.json({ error: `AI parse failed: ${err}` }, { status: 500 });
    }

    const aiParsed = await aiParseRes.json();
    const parsed = JSON.parse(aiParsed.choices[0].message.content);
    const { actions, interpretation } = parsed;

    if (!actions || !actions.length) {
      return Response.json({
        success: false,
        error: 'Could not understand the command',
        interpretation,
        actions_taken: [],
        results: [],
        ai_summary: interpretation,
      });
    }

    // --- Step 2: Execute each action ---
    const actionsTaken: any[] = [];
    const results: any[] = [];

    for (const action of actions) {
      const { type, params } = action;

      if (type === 'block_slot') {
        try {
          const { start_datetime, end_datetime, reason, is_recurring, recurrence_rule } = params;

          let googleEventId = null;
          if (access_token || config.google_refresh_token) {
            try {
              const token = access_token || await refreshGoogleToken(config.google_refresh_token);
              const calendarId = config.calendar_id || 'primary';
              const event: any = {
                summary: reason || 'חסום — לא זמין',
                start: { dateTime: new Date(start_datetime).toISOString(), timeZone: tz },
                end: { dateTime: new Date(end_datetime).toISOString(), timeZone: tz },
                transparency: 'opaque',
              };
              if (is_recurring && recurrence_rule) event.recurrence = [recurrence_rule];
              const gcalRes = await fetch(
                `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
                { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(event) }
              );
              if (gcalRes.ok) googleEventId = (await gcalRes.json()).id;
            } catch (e) { console.error('GCal block error:', e.message); }
          }

          const blocked = await db.BlockedSlot.create({
            business_email,
            start_datetime: new Date(start_datetime).toISOString(),
            end_datetime: new Date(end_datetime).toISOString(),
            reason: reason || 'לא זמין',
            is_recurring: is_recurring || false,
            recurrence_rule: recurrence_rule || '',
            google_event_id: googleEventId,
          });

          actionsTaken.push({ type: 'block_slot', status: 'success', params });
          results.push({ type: 'block_slot', success: true, blocked, google_event_id: googleEventId });
        } catch (e) {
          actionsTaken.push({ type: 'block_slot', status: 'error', error: e.message });
          results.push({ type: 'block_slot', success: false, error: e.message });
        }

      } else if (type === 'book_appointment') {
        try {
          const { client_name, client_email, client_phone, start_datetime, title, notes } = params;
          const durationMin = config.appointment_duration_minutes || 60;
          const start = new Date(start_datetime);
          const end = new Date(start.getTime() + durationMin * 60000);

          // Check for conflicts
          const existing = await db.Appointment.filter({ business_email });
          const conflict = existing.some((a: any) => {
            if (a.status === 'cancelled') return false;
            const aStart = new Date(a.start_datetime);
            const aEnd = new Date(a.end_datetime);
            return start < aEnd && end > aStart;
          });

          if (conflict) {
            actionsTaken.push({ type: 'book_appointment', status: 'conflict', params });
            results.push({ type: 'book_appointment', success: false, error: 'Time slot is not available' });
            continue;
          }

          let googleEventId = null;
          if (access_token || config.google_refresh_token) {
            try {
              const token = access_token || await refreshGoogleToken(config.google_refresh_token);
              const calendarId = config.calendar_id || 'primary';
              const event = {
                summary: title || `פגישה עם ${client_name}`,
                description: notes || '',
                start: { dateTime: start.toISOString(), timeZone: tz },
                end: { dateTime: end.toISOString(), timeZone: tz },
                attendees: client_email ? [{ email: client_email }] : [],
              };
              const gcalRes = await fetch(
                `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
                { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(event) }
              );
              if (gcalRes.ok) googleEventId = (await gcalRes.json()).id;
            } catch (e) { console.error('GCal book error:', e.message); }
          }

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
            booked_via: 'natural_language',
            reminder_sent: false,
          });

          actionsTaken.push({ type: 'book_appointment', status: 'success', params });
          results.push({ type: 'book_appointment', success: true, appointment, google_event_id: googleEventId });
        } catch (e) {
          actionsTaken.push({ type: 'book_appointment', status: 'error', error: e.message });
          results.push({ type: 'book_appointment', success: false, error: e.message });
        }

      } else if (type === 'query_availability') {
        try {
          const { date_from, date_to } = params;
          // Reuse availability logic inline
          const blockedSlots = await db.BlockedSlot.filter({ business_email });
          const appointments = await db.Appointment.filter({ business_email });
          const holidays = await db.Holiday.filter({});
          const durationMin = config.appointment_duration_minutes || 60;
          const bufferMin = config.buffer_minutes || 0;
          const workingDays = config.working_days || [0,1,2,3,4];
          const [startH, startM] = (config.working_hours_start || '08:00').split(':').map(Number);
          const [endH, endM] = (config.working_hours_end || '17:00').split(':').map(Number);
          const holidayDates = new Set(holidays.filter((h: any) => h.default_closed && !config.works_on_holidays).map((h: any) => h.date));

          const slots: any[] = [];
          const cursor = new Date(date_from);
          const toDate = new Date(date_to);
          while (cursor <= toDate) {
            const dayOfWeek = cursor.getDay();
            const dateStr = cursor.toISOString().split('T')[0];
            if (workingDays.includes(dayOfWeek) && !holidayDates.has(dateStr)) {
              const dayStart = new Date(cursor); dayStart.setHours(startH, startM, 0, 0);
              const dayEnd = new Date(cursor); dayEnd.setHours(endH, endM, 0, 0);
              let slotStart = new Date(dayStart);
              while (slotStart.getTime() + durationMin * 60000 <= dayEnd.getTime()) {
                const slotEnd = new Date(slotStart.getTime() + durationMin * 60000);
                const isBlocked = blockedSlots.some((b: any) => slotStart < new Date(b.end_datetime) && slotEnd > new Date(b.start_datetime));
                const isBooked = appointments.some((a: any) => a.status !== 'cancelled' && slotStart < new Date(a.end_datetime) && slotEnd > new Date(a.start_datetime));
                if (!isBlocked && !isBooked) slots.push({ start: slotStart.toISOString(), date: dateStr, time: slotStart.toTimeString().slice(0,5) });
                slotStart = new Date(slotStart.getTime() + (durationMin + bufferMin) * 60000);
              }
            }
            cursor.setDate(cursor.getDate() + 1);
          }

          actionsTaken.push({ type: 'query_availability', status: 'success', params });
          results.push({ type: 'query_availability', success: true, slots, total: slots.length, date_from, date_to });
        } catch (e) {
          actionsTaken.push({ type: 'query_availability', status: 'error', error: e.message });
          results.push({ type: 'query_availability', success: false, error: e.message });
        }

      } else if (type === 'cancel_appointment') {
        try {
          const { appointment_id, client_name, approximate_datetime } = params;
          let appt = null;
          if (appointment_id) {
            appt = await db.Appointment.get(appointment_id);
          } else if (client_name) {
            const all = await db.Appointment.filter({ business_email });
            appt = all.find((a: any) =>
              a.status !== 'cancelled' &&
              a.client_name?.toLowerCase().includes(client_name.toLowerCase())
            );
          }
          if (!appt) {
            actionsTaken.push({ type: 'cancel_appointment', status: 'not_found', params });
            results.push({ type: 'cancel_appointment', success: false, error: 'Appointment not found' });
            continue;
          }
          await db.Appointment.update(appt.id, { status: 'cancelled' });
          actionsTaken.push({ type: 'cancel_appointment', status: 'success', params });
          results.push({ type: 'cancel_appointment', success: true, appointment_id: appt.id, client_name: appt.client_name });
        } catch (e) {
          actionsTaken.push({ type: 'cancel_appointment', status: 'error', error: e.message });
          results.push({ type: 'cancel_appointment', success: false, error: e.message });
        }
      }
    }

    // --- Step 3: Generate human-readable summary ---
    const summaryPrompt = `
Summarize what was done in 1-2 sentences in the same language as the original command.
Original command: "${command}"
Actions taken: ${JSON.stringify(actionsTaken)}
Keep it short and natural, like "חסמתי את יום רביעי בין 8 ל-12 וקבעתי פגישה עם דוד לוי ב-14:00".
Return only the summary text, no JSON.
`;

    const summaryRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${openaiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [{ role: 'user', content: summaryPrompt }],
        temperature: 0.3,
      }),
    });
    const summaryData = await summaryRes.json();
    const aiSummary = summaryData.choices?.[0]?.message?.content || interpretation;

    // Save command to business history
    try {
      const history = config.command_history || [];
      history.unshift({ command, interpretation, actions_count: actionsTaken.length, timestamp: now.toISOString() });
      await db.BusinessConfig.update(config.id, { command_history: history.slice(0, 50) });
    } catch (e) { /* non-critical */ }

    return Response.json({
      success: true,
      interpretation,
      actions_taken: actionsTaken,
      results,
      ai_summary: aiSummary,
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
