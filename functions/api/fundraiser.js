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

export async function onRequestGet({
  request,
  env,
}) {
  try {
    if (
      !env.SUPABASE_URL ||
      !env.SUPABASE_SERVICE_ROLE_KEY ||
      !env.TEAM_KEY
    ) {
      return json(
        {
          success: false,
          error: "Missing fundraiser configuration.",
        },
        500
      );
    }

    const url = new URL(request.url);

    const playerKey =
      url.searchParams.get("player");

    if (!playerKey) {
      return json(
        {
          success: false,
          error: "Player is required.",
        },
        400
      );
    }

    // Find this site's team.
    const teams = await supabaseGet(
      env,
      `teams?team_key=eq.${encodeURIComponent(
        env.TEAM_KEY
      )}&select=id,team_key,team_name&limit=1`
    );

    const team = teams[0];

    if (!team) {
      return json(
        {
          success: false,
          error: "Team not found.",
        },
        404
      );
    }

    // Find the requested player,
    // but ONLY inside this team.
    const players = await supabaseGet(
      env,
      `players?team_id=eq.${encodeURIComponent(
        team.id
      )}&player_key=eq.${encodeURIComponent(
        playerKey
      )}&select=id,player_key,player_name,player_number&limit=1`
    );

    const player = players[0];

    if (!player) {
      return json(
        {
          success: false,
          error: "Player not found.",
        },
        404
      );
    }

    // Load this player's individual board.
    const baseballs = await supabaseGet(
      env,
      `baseballs?player_id=eq.${encodeURIComponent(
        player.id
      )}&select=id,ball_number,amount_cents,status,reserved_until,sold_at&order=ball_number.asc`
    );

    // Until reservation handling is added,
    // don't leave an old reserved ball locked.
    const normalized = (baseballs || []).map(
      (ball) => {
        if (ball.status === "reserved") {
          return {
            ...ball,
            status: "available",
            reserved_until: null,
          };
        }

        return ball;
      }
    );

    const raisedCents = normalized
      .filter(
        (ball) =>
          ball.status === "sold"
      )
      .reduce(
        (sum, ball) =>
          sum +
          Number(
            ball.amount_cents || 0
          ),
        0
      );

    return json({
      success: true,

      team: {
        id: team.id,
        key: team.team_key,
        name: team.team_name,
      },

      player: {
        id: player.id,
        key: player.player_key,
        name: player.player_name,
        number: player.player_number,
      },

      baseballs: normalized,

      totals: {
        baseballCount:
          normalized.length,

        raisedCents,

        raisedDollars:
          raisedCents / 100,

        goalDollars: 5050,
      },
    });

  } catch (error) {
    console.error(
      "Fundraiser API error:",
      error
    );

    return json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
      500
    );
  }
}
