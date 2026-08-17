export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const url = new URL(request.url);
    const playerKey = url.searchParams.get("player");

    if (!playerKey) {
      return jsonResponse(
        {
          success: false,
          error: "Missing player."
        },
        400
      );
    }

    const SUPABASE_URL = env.SUPABASE_URL;

    const SUPABASE_SERVICE_ROLE_KEY =
      env.SUPABASE_SERVICE_ROLE_KEY;

    const TEAM_KEY =
      env.TEAM_KEY || "plantation-stars-blue";

    if (
      !SUPABASE_URL ||
      !SUPABASE_SERVICE_ROLE_KEY
    ) {
      return jsonResponse(
        {
          success: false,
          error:
            "Supabase environment variables are missing."
        },
        500
      );
    }

    const headers = {
      apikey: SUPABASE_SERVICE_ROLE_KEY,

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
          headers
        }
      );

    if (!teamResponse.ok) {
      return jsonResponse(
        {
          success: false,
          error: "Unable to load team."
        },
        500
      );
    }

    const teams =
      await teamResponse.json();

    if (!teams.length) {
      return jsonResponse(
        {
          success: false,
          error: "Team not found."
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
          headers
        }
      );

    if (!playerResponse.ok) {
      return jsonResponse(
        {
          success: false,
          error: "Unable to load player."
        },
        500
      );
    }

    const players =
      await playerResponse.json();

    if (!players.length) {
      return jsonResponse(
        {
          success: false,
          error: "Player not found."
        },
        404
      );
    }

    const player = players[0];


    /* =========================
       LOAD PLAYER BOARD
    ========================= */

    const baseballResponse =
      await fetch(
        `${SUPABASE_URL}/rest/v1/baseballs?player_id=eq.${player.id}&select=id,ball_number,amount_cents,status,reserved_until,sold_at,stripe_session_id,donor_name&order=ball_number.asc`,
        {
          headers
        }
      );

    if (!baseballResponse.ok) {
      return jsonResponse(
        {
          success: false,
          error:
            "Unable to load baseball board."
        },
        500
      );
    }

    const baseballRows =
      await baseballResponse.json();


    /* =========================
       NORMALIZE STATUSES
    ========================= */

    const baseballs =
      baseballRows.map(ball => {
        let status = ball.status;

        if (status === "reserved") {
          if (!ball.reserved_until) {
            status = "available";
          } else {
            const reservedUntil =
              new Date(
                ball.reserved_until
              ).getTime();

            if (
              !Number.isFinite(reservedUntil) ||
              reservedUntil <= Date.now()
            ) {
              status = "available";
            }
          }
        }

        return {
          id: ball.id,

          ball_number:
            ball.ball_number,

          amount_cents:
            ball.amount_cents,

          status,

          donor_name:
            ball.donor_name || null,

          reserved_until:
            ball.reserved_until,

          sold_at:
            ball.sold_at,

          stripe_session_id:
            ball.stripe_session_id
        };
      });


    /* =========================
       PLAYER TOTALS
    ========================= */

    const soldBalls =
      baseballRows.filter(
        ball =>
          ball.status === "sold"
      );

    const raisedCents =
      soldBalls.reduce(
        (total, ball) =>
          total +
          Number(
            ball.amount_cents || 0
          ),
        0
      );

    const soldCount =
      soldBalls.length;

    const remainingCount =
      baseballs.filter(
        ball =>
          ball.status === "available"
      ).length;

    const goalCents =
      505000;


    /* =========================
       RESPONSE
    ========================= */

    return jsonResponse(
      {
        success: true,

        team: {
          id: team.id,
          key: team.team_key,
          name: team.team_name
        },

        player: {
          id: player.id,
          key: player.player_key,
          name: player.player_name,
          number: player.player_number
        },

        baseballs,

        totals: {
          raisedCents,
          raisedDollars:
            raisedCents / 100,

          goalCents,
          goalDollars: 5050,

          soldCount,
          remainingCount
        }
      },
      200
    );

  } catch (error) {
    console.error(
      "Fundraiser API error:",
      error
    );

    return jsonResponse(
      {
        success: false,
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
