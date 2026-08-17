export async function onRequestGet(context) {
  const { request, env } = context;

  try {
    const url = new URL(request.url);
    const playerKey = url.searchParams.get("player");

    if (!playerKey) {
      return jsonResponse(
        { error: "Missing player." },
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
      "Content-Type": "application/json"
    };


    /* =========================
       FIND TEAM
    ========================= */

    const teamResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/teams?team_key=eq.${encodeURIComponent(
        TEAM_KEY
      )}&select=id,team_name,team_key&limit=1`,
      {
        headers
      }
    );

    if (!teamResponse.ok) {
      console.error(
        "Team lookup error:",
        await teamResponse.text()
      );

      return jsonResponse(
        { error: "Unable to load team." },
        500
      );
    }

    const teams =
      await teamResponse.json();

    if (!teams.length) {
      return jsonResponse(
        { error: "Team not found." },
        404
      );
    }

    const team = teams[0];


    /* =========================
       FIND SELECTED PLAYER
    ========================= */

    const playerResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/players?team_id=eq.${team.id}&player_key=eq.${encodeURIComponent(
        playerKey
      )}&select=id,player_key,player_name,player_number&limit=1`,
      {
        headers
      }
    );

    if (!playerResponse.ok) {
      console.error(
        "Player lookup error:",
        await playerResponse.text()
      );

      return jsonResponse(
        { error: "Unable to load player." },
        500
      );
    }

    const players =
      await playerResponse.json();

    if (!players.length) {
      return jsonResponse(
        { error: "Player not found." },
        404
      );
    }

    const player = players[0];


    /* =========================
       LOAD ONE SHARED TEAM BOARD
    ========================= */

    const baseballResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/shared_baseballs?team_id=eq.${team.id}&select=id,ball_number,amount_cents,status,supported_player_id,sold_at&order=ball_number.asc`,
      {
        headers
      }
    );

    if (!baseballResponse.ok) {
      console.error(
        "Shared baseball lookup error:",
        await baseballResponse.text()
      );

      return jsonResponse(
        {
          error:
            "Unable to load baseball board."
        },
        500
      );
    }

    const baseballRows =
      await baseballResponse.json();


    /* =========================
       LOAD HISTORICAL ADJUSTMENTS
    ========================= */

    const adjustmentResponse = await fetch(
      `${SUPABASE_URL}/rest/v1/shared_board_adjustments?team_id=eq.${team.id}&select=amount_cents`,
      {
        headers
      }
    );

    if (!adjustmentResponse.ok) {
      console.error(
        "Adjustment lookup error:",
        await adjustmentResponse.text()
      );

      return jsonResponse(
        {
          error:
            "Unable to load historical fundraiser totals."
        },
        500
      );
    }

    const adjustments =
      await adjustmentResponse.json();


    /* =========================
       NORMALIZE BOARD
    ========================= */

    const baseballs =
      baseballRows.map(ball => {
        let displayStatus =
          ball.status;

        if (
          displayStatus === "reserved"
        ) {
          displayStatus = "sold";
        }

        return {
          id: ball.id,
          ball_number:
            ball.ball_number,
          amount_cents:
            ball.amount_cents,
          status:
            displayStatus,
          supported_player_id:
            ball.supported_player_id,
          sold_at:
            ball.sold_at
        };
      });


    /* =========================
       CALCULATE TOTALS
    ========================= */

    const soldBalls =
      baseballRows.filter(
        ball =>
          ball.status === "sold"
      );

    const sharedRaisedCents =
      soldBalls.reduce(
        (total, ball) =>
          total +
          Number(
            ball.amount_cents || 0
          ),
        0
      );

    const adjustmentCents =
      adjustments.reduce(
        (total, row) =>
          total +
          Number(
            row.amount_cents || 0
          ),
        0
      );

    const raisedCents =
      sharedRaisedCents +
      adjustmentCents;

    const soldCount =
      soldBalls.length;

    const remainingCount =
      baseballRows.filter(
        ball =>
          ball.status ===
          "available"
      ).length;


    /* =========================
       RESPONSE
    ========================= */

    return jsonResponse(
      {
        team: {
          id: team.id,
          team_name:
            team.team_name,
          team_key:
            team.team_key
        },

        player: {
          id: player.id,
          player_key:
            player.player_key,
          player_name:
            player.player_name,
          player_number:
            player.player_number
        },

        baseballs,

        totals: {
          raised_cents:
            raisedCents,

          sold_count:
            soldCount,

          remaining_count:
            remainingCount,

          goal_cents:
            505000
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
