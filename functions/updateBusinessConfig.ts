import { createClientFromRequest } from 'npm:@base44/sdk@0.8.23';

// Creates or updates a business configuration
// Used by host apps to register a business and configure its availability

Deno.serve(async (req) => {
  try {
    const base44 = createClientFromRequest(req);
    const body = await req.json().catch(() => ({}));

    const {
      email,
      business_name,
      business_type,
      working_days,
      working_hours_start,
      working_hours_end,
      appointment_duration_minutes,
      buffer_minutes,
      works_on_holidays,
      calendar_id,
      google_refresh_token,
      timezone,
      ai_instructions,
      command, // optional: the natural language command that triggered this update
    } = body;

    if (!email) {
      return Response.json({ error: 'Missing required field: email' }, { status: 400 });
    }

    const db = base44.asServiceRole.entities;

    // Check if business exists
    const existing = await db.BusinessConfig.filter({ email });

    const updateData: any = {};
    if (business_name !== undefined) updateData.business_name = business_name;
    if (business_type !== undefined) updateData.business_type = business_type;
    if (working_days !== undefined) updateData.working_days = working_days;
    if (working_hours_start !== undefined) updateData.working_hours_start = working_hours_start;
    if (working_hours_end !== undefined) updateData.working_hours_end = working_hours_end;
    if (appointment_duration_minutes !== undefined) updateData.appointment_duration_minutes = appointment_duration_minutes;
    if (buffer_minutes !== undefined) updateData.buffer_minutes = buffer_minutes;
    if (works_on_holidays !== undefined) updateData.works_on_holidays = works_on_holidays;
    if (calendar_id !== undefined) updateData.calendar_id = calendar_id;
    if (google_refresh_token !== undefined) updateData.google_refresh_token = google_refresh_token;
    if (timezone !== undefined) updateData.timezone = timezone;
    if (ai_instructions !== undefined) updateData.ai_instructions = ai_instructions;

    let result;

    if (existing.length) {
      const config = existing[0];

      // Append to command history if a command was provided
      if (command) {
        const history = config.command_history || [];
        history.push({ command, timestamp: new Date().toISOString(), changes: updateData });
        updateData.command_history = history;
      }

      result = await db.BusinessConfig.update(config.id, updateData);
      return Response.json({ success: true, action: 'updated', config: result });
    } else {
      // Create new
      updateData.email = email;
      if (command) {
        updateData.command_history = [{ command, timestamp: new Date().toISOString(), changes: updateData }];
      }
      result = await db.BusinessConfig.create(updateData);
      return Response.json({ success: true, action: 'created', config: result });
    }
  } catch (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
});
