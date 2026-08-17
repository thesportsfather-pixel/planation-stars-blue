export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const SUPABASE_URL = env.SUPABASE_URL;
    const SUPABASE_SERVICE_ROLE_KEY =
      env.SUPABASE_SERVICE_ROLE_KEY;
    const STRIPE_SECRET_KEY =
      env.STRIPE_SECRET_KEY;
    const TEAM_KEY =
      env.TEAM_KEY || "plantation-stars-blue";

    if (
      !SUPABASE_URL ||
      !SUPABASE_SERVICE_ROLE_KEY
    ) {
      return jsonResponse(
        {
          error:
            "Supabase environment variables are missing."
        },
        500
      );
    }

    if (!STRIPE_SECRET_KEY) {
      return jsonResponse(
        {
          error:
            "Stripe is not configured."
        },
        500
      );
    }

    const body =
      await request.json();

    const playerKey =
      body.playerKey ||
      body.player;

    const requestedBaseballs =
      Array.isArray(body.baseballs)
        ? body.baseballs
        : Array.isArray(body.baseball_numbers)
          ? body.baseball_numbers
          : [];

    const donorName =
      String(
        body.donorName ||
        body.donor_name ||
        ""
      )
        .trim()
        .replace(/\s+/g, " ");

    if (!playerKey) {
      return jsonResponse(
        {
          error:
            "Missing player."
        },
        400
      );
    }

    if (!donorName) {
      return jsonResponse(
        {
          error:
            "Please enter a donor name or choose Anonymous."
        },
        400
      );
    }

    if (donorName.length > 50) {
      return jsonResponse(
        {
          error:
            "Donor name must be 50 characters or fewer."
        },
        400
      );
    }

    if (
      requestedBaseballs.length === 0
    ) {
      return jsonResponse(
        {
          error:
            "Select at least one baseball."
        },
        400
      );
    }

    const baseballNumbers = [
      ...new Set(
        requestedBaseballs.map(Number)
      )
    ].sort(
      (a, b) => a - b
    );

    if (
      baseballNumbers.some(
        number =>
          !Number.isInteger(number) ||
          number < 1 ||
          number > 100
      )
    ) {
      return jsonResponse(
        {
          error:
            "Invalid baseball selection."
        },
        400
      );
    }

    const supabaseHeaders = {
      apikey:
        SUPABASE_SERVICE_ROLE_KEY,

      Authorization:
        `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,

      "Content-Type":
        "application/json"
    };


    /* =========================
       FIND TEAM
    ========================= */

    const teamResponse =
      await fetch(
        `${SUPABASE_URL}/rest/v1/teams?team_key=eq.${encodeURIComponent(
          TEAM_KEY
        )}&select=id,team_name,team_key&limit=1`,
        {
          headers:
            supabaseHeaders
        }
      );

    if (!teamResponse.ok) {
      return jsonResponse(
        {
          error:
            "Unable to load team."
        },
        500
      );
    }

    const teams =
      await teamResponse.json();

    if (!teams.length) {
      return jsonResponse(
        {
          error:
            "Team not found."
        },
        404
      );
    }

    const team = teams[0];


    /* =========================
       FIND PLAYER
    ========================= */

    const playerResponse =
      await fetch(
        `${SUPABASE_URL}/rest/v1/players?team_id=eq.${team.id}&player_key=eq.${encodeURIComponent(
          playerKey
        )}&select=id,player_key,player_name,player_number&limit=1`,
        {
          headers:
            supabaseHeaders
        }
      );

    if (!playerResponse.ok) {
      return jsonResponse(
        {
          error:
            "Unable to load player."
        },
        500
      );
    }

    const players =
      await playerResponse.json();

    if (!players.length) {
      return jsonResponse(
        {
          error:
            "Player not found."
        },
        404
      );
    }

    const player = players[0];


    /* =========================
       LOAD SELECTED BASEBALLS
    ========================= */

    const ballFilter =
      baseballNumbers.join(",");

    const baseballResponse =
      await fetch(
        `${SUPABASE_URL}/rest/v1/baseballs?player_id=eq.${encodeURIComponent(
          player.id
        )}&ball_number=in.(${ballFilter})&select=id,ball_number,amount_cents,status,reserved_until`,
        {
          headers:
            supabaseHeaders
        }
      );

    if (!baseballResponse.ok) {
      return jsonResponse(
        {
          error:
            "Unable to verify baseballs."
        },
        500
      );
    }

    const baseballs =
      await baseballResponse.json();

    if (
      baseballs.length !==
      baseballNumbers.length
    ) {
      return jsonResponse(
        {
          error:
            "One or more baseballs could not be found."
        },
        400
      );
    }


    /* =========================
       CHECK AVAILABILITY
    ========================= */

    const now =
      Date.now();

    const unavailable =
      baseballs.filter(
        ball => {

          if (
            ball.status === "sold"
          ) {
            return true;
          }

          if (
            ball.status === "reserved" &&
            ball.reserved_until
          ) {
            const reservedUntil =
              new Date(
                ball.reserved_until
              ).getTime();

            if (
              Number.isFinite(
                reservedUntil
              ) &&
              reservedUntil > now
            ) {
              return true;
            }
          }

          return false;
        }
      );

    if (
      unavailable.length > 0
    ) {
      return jsonResponse(
        {
          error:
            "One or more selected baseballs are no longer available. Please refresh the page."
        },
        409
      );
    }


    /* =========================
       CALCULATE TOTAL
    ========================= */

    const totalCents =
      baseballs.reduce(
        (total, ball) =>
          total +
          Number(
            ball.amount_cents || 0
          ),
        0
      );

    if (
      totalCents <= 0
    ) {
      return jsonResponse(
        {
          error:
            "Invalid checkout amount."
        },
        400
      );
    }


    /* =========================
       RESERVE BALLS + SAVE NAME
    ========================= */

    const reservedUntil =
      new Date(
        Date.now() +
        30 * 60 * 1000
      ).toISOString();

    const reserveResponse =
      await fetch(
        `${SUPABASE_URL}/rest/v1/baseballs?player_id=eq.${encodeURIComponent(
          player.id
        )}&ball_number=in.(${ballFilter})&status=neq.sold`,
        {
          method: "PATCH",

          headers: {
            ...supabaseHeaders,
            Prefer:
              "return=minimal"
          },

          body:
            JSON.stringify({
              status:
                "reserved",

              reserved_until:
                reservedUntil,

              donor_name:
                donorName
            })
        }
      );

    if (!reserveResponse.ok) {
      console.error(
        "Reservation error:",
        await reserveResponse.text()
      );

      return jsonResponse(
        {
          error:
            "Unable to reserve selected baseballs."
        },
        500
      );
    }


    /* =========================
       CREATE STRIPE SESSION
    ========================= */

    const origin =
      new URL(
        request.url
      ).origin;

    const form =
      new URLSearchParams();

    form.append(
      "mode",
      "payment"
    );

    form.append(
      "payment_method_types[0]",
      "card"
    );

    form.append(
      "line_items[0][price_data][currency]",
      "usd"
    );

    form.append(
      "line_items[0][price_data][unit_amount]",
      String(totalCents)
    );

    form.append(
      "line_items[0][price_data][product_data][name]",
      `Plantation Stars Blue — ${player.player_name}`
    );

    form.append(
      "line_items[0][price_data][product_data][description]",
      `Donor: ${donorName} | Baseballs: ${baseballNumbers
        .map(
          number =>
            `#${number}`
        )
        .join(", ")}`
    );

    form.append(
      "line_items[0][quantity]",
      "1"
    );

    form.append(
      "success_url",
      `${origin}/fundraiser?player=${encodeURIComponent(
        player.player_key
      )}&success=1`
    );

    form.append(
      "cancel_url",
      `${origin}/fundraiser?player=${encodeURIComponent(
        player.player_key
      )}&canceled=1`
    );


    /* =========================
       METADATA
    ========================= */

    form.append(
      "metadata[team_key]",
      TEAM_KEY
    );

    form.append(
      "metadata[team_id]",
      team.id
    );

    form.append(
      "metadata[player_id]",
      player.id
    );

    form.append(
      "metadata[player_key]",
      player.player_key
    );

    form.append(
      "metadata[player_name]",
      player.player_name
    );

    form.append(
      "metadata[baseball_numbers]",
      baseballNumbers.join(",")
    );

    form.append(
      "metadata[donor_name]",
      donorName
    );


    const stripeResponse =
      await fetch(
        "https://api.stripe.com/v1/checkout/sessions",
        {
          method: "POST",

          headers: {
            Authorization:
              `Bearer ${STRIPE_SECRET_KEY}`,

            "Content-Type":
              "application/x-www-form-urlencoded"
          },

          body:
            form.toString()
        }
      );

    const stripeData =
      await stripeResponse.json();


    /* =========================
       STRIPE FAILED
       RELEASE RESERVATION
    ========================= */

    if (!stripeResponse.ok) {

      console.error(
        "Stripe error:",
        stripeData
      );

      await fetch(
        `${SUPABASE_URL}/rest/v1/baseballs?player_id=eq.${encodeURIComponent(
          player.id
        )}&ball_number=in.(${ballFilter})&status=eq.reserved`,
        {
          method: "PATCH",

          headers: {
            ...supabaseHeaders,
            Prefer:
              "return=minimal"
          },

          body:
            JSON.stringify({
              status:
                "available",

              reserved_until:
                null,

              donor_name:
                null
            })
        }
      );

      return jsonResponse(
        {
          error:
            stripeData?.error?.message ||
            "Unable to create checkout."
        },
        500
      );
    }


    return jsonResponse(
      {
        url:
          stripeData.url
      },
      200
    );

  } catch (error) {

    console.error(
      "Create checkout error:",
      error
    );

    return jsonResponse(
      {
        error:
          "Unexpected server error."
      },
      500
    );
  }
}


function jsonResponse(
  data,
  status = 200
) {

  return new Response(
    JSON.stringify(data),
    {
      status,

      headers: {
        "Content-Type":
          "application/json",

        "Cache-Control":
          "no-store"
      }
    }
  );
}
