function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

function hexToBytes(hex) {
  if (!/^[0-9a-f]+$/i.test(hex) || hex.length % 2 !== 0) {
    return null;
  }

  const bytes = new Uint8Array(hex.length / 2);

  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }

  return bytes;
}

function timingSafeEqual(a, b) {
  if (!a || !b || a.length !== b.length) {
    return false;
  }

  let diff = 0;

  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }

  return diff === 0;
}

async function verifyStripeSignature(
  rawBody,
  signatureHeader,
  secret
) {
  const parts = signatureHeader.split(",");

  let timestamp = null;
  const signatures = [];

  for (const part of parts) {
    const [key, value] = part.split("=", 2);

    if (key === "t") {
      timestamp = value;
    }

    if (key === "v1") {
      signatures.push(value);
    }
  }

  if (!timestamp || signatures.length === 0) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);

  if (Math.abs(now - Number(timestamp)) > 300) {
    return false;
  }

  const encoder = new TextEncoder();
  const signedPayload = `${timestamp}.${rawBody}`;

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    {
      name: "HMAC",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );

  const digest = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      encoder.encode(signedPayload)
    )
  );

  return signatures.some((signature) => {
    const expected = hexToBytes(signature);
    return timingSafeEqual(digest, expected);
  });
}

async function supabaseGet(env, path) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;

  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/${path}`,
    {
      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        accept: "application/json",
      },
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${text}`
    );
  }

  return text ? JSON.parse(text) : [];
}

async function supabasePatch(env, path, data) {
  const key = env.SUPABASE_SERVICE_ROLE_KEY;

  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/${path}`,
    {
      method: "PATCH",

      headers: {
        apikey: key,
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        prefer: "return=representation",
        accept: "application/json",
      },

      body: JSON.stringify(data),
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${text}`
    );
  }

  return text ? JSON.parse(text) : [];
}

export async function onRequestPost({
  request,
  env,
}) {
  try {
    if (
      !env.SUPABASE_URL ||
      !env.SUPABASE_SERVICE_ROLE_KEY ||
      !env.TEAM_KEY ||
      !env.STRIPE_WEBHOOK_SECRET
    ) {
      return new Response(
        "Missing server configuration.",
        { status: 500 }
      );
    }

    const signature = request.headers.get(
      "stripe-signature"
    );

    if (!signature) {
      return new Response(
        "Missing Stripe-Signature header.",
        { status: 400 }
      );
    }

    const rawBody = await request.text();

    const valid = await verifyStripeSignature(
      rawBody,
      signature,
      env.STRIPE_WEBHOOK_SECRET
    );

    if (!valid) {
      return new Response(
        "Webhook Error: Invalid Stripe signature.",
        { status: 400 }
      );
    }

    const event = JSON.parse(rawBody);

    if (
      event.type ===
      "checkout.session.completed"
    ) {
      const session =
        event.data.object;

      if (
        session.payment_status !==
        "paid"
      ) {
        return json({
          received: true,
          ignored: true,
          reason:
            "payment_not_paid",
        });
      }

      const teamId =
        session.metadata?.team_id;

      const teamKey =
        session.metadata?.team_key;

      const playerId =
        session.metadata?.player_id;

      const baseballCsv =
        session.metadata
          ?.baseball_numbers;

      if (
        !teamId ||
        !teamKey ||
        !playerId ||
        !baseballCsv
      ) {
        return json(
          {
            received: true,
            error:
              "Missing fundraiser metadata.",
          },
          400
        );
      }

      // Prevent another team's checkout
      // from being fulfilled on this site.
      if (
        teamKey !==
        env.TEAM_KEY
      ) {
        return json(
          {
            received: true,
            error:
              "Team mismatch.",
          },
          400
        );
      }

      const players =
        await supabaseGet(
          env,
          `players?id=eq.${encodeURIComponent(
            playerId
          )}&team_id=eq.${encodeURIComponent(
            teamId
          )}&select=id&limit=1`
        );

      if (!players[0]) {
        return json(
          {
            received: true,
            error:
              "Player does not belong to this team.",
          },
          400
        );
      }

      const baseballNumbers =
        baseballCsv
          .split(",")
          .map(
            (value) =>
              Number(
                value.trim()
              )
          )
          .filter(
            (value) =>
              Number.isInteger(
                value
              ) &&
              value >= 1 &&
              value <= 100
          );

      if (
        !baseballNumbers.length
      ) {
        return json(
          {
            received: true,
            error:
              "No valid baseball numbers in metadata.",
          },
          400
        );
      }

      const soldRows =
        await supabasePatch(
          env,
          `baseballs?player_id=eq.${encodeURIComponent(
            playerId
          )}&ball_number=in.(${baseballNumbers.join(
            ","
          )})`,
          {
            status: "sold",
            sold_at:
              new Date().toISOString(),
            reserved_until: null,
            stripe_session_id:
              session.id,
          }
        );

      console.log(
        "Stars fundraiser payment fulfilled",
        {
          sessionId:
            session.id,

          teamKey,

          playerId,

          baseballNumbers,

          amountTotal:
            session.amount_total,

          updatedRows:
            soldRows.length,
        }
      );
    }

    return json({
      received: true,
    });

  } catch (error) {
    console.error(
      "Stripe webhook fulfillment error:",
      error
    );

    return json(
      {
        received: true,

        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500
    );
  }
}
