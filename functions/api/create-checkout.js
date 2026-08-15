function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
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

export async function onRequestPost({
  request,
  env,
}) {
  try {
    if (
      !env.SUPABASE_URL ||
      !env.SUPABASE_SERVICE_ROLE_KEY ||
      !env.TEAM_KEY ||
      !env.STRIPE_SECRET_KEY
    ) {
      return json(
        {
          error:
            "Missing server configuration.",
        },
        500
      );
    }

    const body =
      await request.json();

    const {
      playerKey,
      baseballs,
    } = body || {};

    if (
      typeof playerKey !== "string" ||
      !Array.isArray(baseballs) ||
      baseballs.length === 0
    ) {
      return json(
        {
          error:
            "A player and at least one baseball are required.",
        },
        400
      );
    }

    const selectedNumbers = [
      ...new Set(
        baseballs
          .map((n) => Number(n))
          .filter(
            (n) =>
              Number.isInteger(n) &&
              n >= 1 &&
              n <= 100
          )
      ),
    ].sort(
      (a, b) => a - b
    );

    if (
      selectedNumbers.length === 0 ||
      selectedNumbers.length !==
        baseballs.length
    ) {
      return json(
        {
          error:
            "Invalid baseball selection.",
        },
        400
      );
    }

    const teams =
      await supabaseGet(
        env,
        `teams?team_key=eq.${encodeURIComponent(
          env.TEAM_KEY
        )}&select=id,team_key,team_name&limit=1`
      );

    const team = teams[0];

    if (!team) {
      return json(
        {
          error: "Team not found.",
        },
        404
      );
    }

    const players =
      await supabaseGet(
        env,
        `players?team_id=eq.${encodeURIComponent(
          team.id
        )}&player_key=eq.${encodeURIComponent(
          playerKey
        )}&select=id,player_key,player_name,player_number&limit=1`
      );

    const player =
      players[0];

    if (!player) {
      return json(
        {
          error: "Player not found.",
        },
        404
      );
    }

    const inList =
      selectedNumbers.join(",");

    const rows =
      await supabaseGet(
        env,
        `baseballs?player_id=eq.${encodeURIComponent(
          player.id
        )}&ball_number=in.(${inList})&select=id,ball_number,amount_cents,status&order=ball_number.asc`
      );

    if (
      !rows ||
      rows.length !==
        selectedNumbers.length
    ) {
      return json(
        {
          error:
            "One or more baseballs could not be found.",
        },
        409
      );
    }

    const unavailable =
      rows.filter(
        (ball) =>
          ball.status === "sold"
      );

    if (
      unavailable.length
    ) {
      return json(
        {
          error:
            "Baseball(s) #" +
            unavailable
              .map(
                (b) =>
                  b.ball_number
              )
              .join(", #") +
            " are already sold.",
        },
        409
      );
    }

    const totalCents =
      rows.reduce(
        (sum, ball) =>
          sum +
          Number(
            ball.amount_cents || 0
          ),
        0
      );

    const origin =
      new URL(
        request.url
      ).origin;

    const form =
      new URLSearchParams();

    form.set(
      "mode",
      "payment"
    );

    form.set(
      "line_items[0][price_data][currency]",
      "usd"
    );

    form.set(
      "line_items[0][price_data][unit_amount]",
      String(totalCents)
    );

    form.set(
      "line_items[0][price_data][product_data][name]",
      `${team.team_name} Road to Cooperstown Fundraiser`
    );

    form.set(
      "line_items[0][price_data][product_data][description]",
      `#${player.player_number} ${player.player_name} — Baseballs #${selectedNumbers.join(", #")}`
    );

    form.set(
      "line_items[0][quantity]",
      "1"
    );

    form.set(
      "success_url",
      `${origin}/fundraiser.html?player=${encodeURIComponent(
        player.player_key
      )}&payment=success&session_id={CHECKOUT_SESSION_ID}`
    );

    form.set(
      "cancel_url",
      `${origin}/fundraiser.html?player=${encodeURIComponent(
        player.player_key
      )}&payment=cancelled`
    );

    form.set(
      "metadata[team_id]",
      String(team.id)
    );

    form.set(
      "metadata[team_key]",
      team.team_key
    );

    form.set(
      "metadata[player_id]",
      String(player.id)
    );

    form.set(
      "metadata[player_key]",
      player.player_key
    );

    form.set(
      "metadata[player_name]",
      player.player_name
    );

    form.set(
      "metadata[player_number]",
      String(
        player.player_number
      )
    );

    form.set(
      "metadata[baseball_numbers]",
      selectedNumbers.join(",")
    );

    form.set(
      "metadata[donation_total_cents]",
      String(totalCents)
    );

    const stripeResponse =
      await fetch(
        "https://api.stripe.com/v1/checkout/sessions",
        {
          method: "POST",

          headers: {
            authorization:
              `Bearer ${env.STRIPE_SECRET_KEY}`,

            "content-type":
              "application/x-www-form-urlencoded",
          },

          body:
            form.toString(),
        }
      );

    const stripeText =
      await stripeResponse.text();

    let session;

    try {
      session =
        JSON.parse(
          stripeText
        );
    } catch {
      return json(
        {
          error:
            "Stripe returned an invalid response.",
        },
        500
      );
    }

    if (
      !stripeResponse.ok
    ) {
      return json(
        {
          error:
            session?.error
              ?.message ||
            "Unable to create Stripe checkout session.",
        },
        stripeResponse.status
      );
    }

    return json({
      url: session.url,
      sessionId:
        session.id,
      totalCents,
    });

  } catch (error) {
    console.error(
      "Create checkout error:",
      error
    );

    return json(
      {
        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500
    );
  }
}
