export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    const SUPABASE_URL =
      env.SUPABASE_URL;

    const SUPABASE_SERVICE_ROLE_KEY =
      env.SUPABASE_SERVICE_ROLE_KEY;

    const STRIPE_WEBHOOK_SECRET =
      env.STRIPE_WEBHOOK_SECRET;

    const TEAM_KEY =
      env.TEAM_KEY || "plantation-stars-blue";


    if (
      !SUPABASE_URL ||
      !SUPABASE_SERVICE_ROLE_KEY
    ) {
      return new Response(
        "Missing Supabase configuration.",
        {
          status: 500
        }
      );
    }


    if (!STRIPE_WEBHOOK_SECRET) {
      return new Response(
        "Missing Stripe webhook secret.",
        {
          status: 500
        }
      );
    }


    const signature =
      request.headers.get(
        "stripe-signature"
      );


    if (!signature) {
      return new Response(
        "Missing Stripe signature.",
        {
          status: 400
        }
      );
    }


    const rawBody =
      await request.text();


    const verified =
      await verifyStripeSignature(
        rawBody,
        signature,
        STRIPE_WEBHOOK_SECRET
      );


    if (!verified) {
      return new Response(
        "Invalid Stripe signature.",
        {
          status: 400
        }
      );
    }


    const event =
      JSON.parse(rawBody);


    /* =========================
       ONLY HANDLE SUCCESSFUL
       CHECKOUT SESSIONS
    ========================= */

    if (
      event.type !==
      "checkout.session.completed"
    ) {
      return new Response(
        "Ignored",
        {
          status: 200
        }
      );
    }


    const session =
      event.data.object;


    if (
      session.payment_status !==
      "paid"
    ) {
      return new Response(
        "Payment not completed.",
        {
          status: 200
        }
      );
    }


    const metadata =
      session.metadata || {};


    /* =========================
       VERIFY TEAM
    ========================= */

    if (
      metadata.team_key !==
      TEAM_KEY
    ) {
      return new Response(
        "Wrong team.",
        {
          status: 200
        }
      );
    }


    const teamId =
      metadata.team_id;

    const playerId =
      metadata.player_id;

    const baseballNumbersRaw =
      metadata.baseball_numbers;


    if (
      !teamId ||
      !playerId ||
      !baseballNumbersRaw
    ) {
      return new Response(
        "Missing checkout metadata.",
        {
          status: 400
        }
      );
    }


    const baseballNumbers =
      baseballNumbersRaw
        .split(",")
        .map(Number)
        .filter(
          number =>
            Number.isInteger(number) &&
            number >= 1 &&
            number <= 100
        );


    if (
      baseballNumbers.length === 0
    ) {
      return new Response(
        "No valid baseball numbers.",
        {
          status: 400
        }
      );
    }


    const supabaseHeaders = {
      apikey:
        SUPABASE_SERVICE_ROLE_KEY,

      Authorization:
        `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,

      "Content-Type":
        "application/json",

      Prefer:
        "return=minimal"
    };


    /* =========================
       VERIFY PLAYER BELONGS
       TO PLANTATION STARS
    ========================= */

    const playerResponse =
      await fetch(
        `${SUPABASE_URL}/rest/v1/players?id=eq.${encodeURIComponent(
          playerId
        )}&team_id=eq.${encodeURIComponent(
          teamId
        )}&select=id&limit=1`,
        {
          headers:
            supabaseHeaders
        }
      );


    if (!playerResponse.ok) {
      console.error(
        "Player verification error:",
        await playerResponse.text()
      );

      return new Response(
        "Player verification failed.",
        {
          status: 500
        }
      );
    }


    const players =
      await playerResponse.json();


    if (!players.length) {
      return new Response(
        "Invalid player.",
        {
          status: 400
        }
      );
    }


    /* =========================
       VERIFY BASEBALLS ARE
       STILL AVAILABLE
    ========================= */

    const ballFilter =
      baseballNumbers.join(",");


    const checkResponse =
      await fetch(
        `${SUPABASE_URL}/rest/v1/shared_baseballs?team_id=eq.${encodeURIComponent(
          teamId
        )}&ball_number=in.(${ballFilter})&select=id,ball_number,status`,
        {
          headers:
            supabaseHeaders
        }
      );


    if (!checkResponse.ok) {
      console.error(
        "Baseball verification error:",
        await checkResponse.text()
      );

      return new Response(
        "Baseball verification failed.",
        {
          status: 500
        }
      );
    }


    const selectedBaseballs =
      await checkResponse.json();


    if (
      selectedBaseballs.length !==
      baseballNumbers.length
    ) {
      return new Response(
        "One or more baseballs were not found.",
        {
          status: 400
        }
      );
    }


    const unavailable =
      selectedBaseballs.filter(
        ball =>
          ball.status !==
          "available"
      );


    /*
      Stripe may retry the same webhook.

      If every ball is already sold using
      this exact Stripe session, we want
      to safely return success instead of
      creating an error.

      We check that below.
    */

    if (
      unavailable.length > 0
    ) {

      const sessionCheckResponse =
        await fetch(
          `${SUPABASE_URL}/rest/v1/shared_baseballs?team_id=eq.${encodeURIComponent(
            teamId
          )}&ball_number=in.(${ballFilter})&stripe_session_id=eq.${encodeURIComponent(
            session.id
          )}&select=id`,
          {
            headers:
              supabaseHeaders
          }
        );


      if (sessionCheckResponse.ok) {

        const alreadyProcessed =
          await sessionCheckResponse.json();


        if (
          alreadyProcessed.length ===
          baseballNumbers.length
        ) {
          return new Response(
            "Already processed.",
            {
              status: 200
            }
          );
        }

      }


      return new Response(
        "One or more baseballs are no longer available.",
        {
          status: 409
        }
      );
    }


    /* =========================
       MARK SHARED BASEBALLS SOLD
    ========================= */

    const updateResponse =
      await fetch(
        `${SUPABASE_URL}/rest/v1/shared_baseballs?team_id=eq.${encodeURIComponent(
          teamId
        )}&ball_number=in.(${ballFilter})&status=eq.available`,
        {
          method: "PATCH",

          headers:
            supabaseHeaders,

          body:
            JSON.stringify({
              status:
                "sold",

              supported_player_id:
                playerId,

              sold_at:
                new Date().toISOString(),

              stripe_session_id:
                session.id
            })
        }
      );


    if (!updateResponse.ok) {
      console.error(
        "Shared baseball update error:",
        await updateResponse.text()
      );

      return new Response(
        "Unable to update baseballs.",
        {
          status: 500
        }
      );
    }


    return new Response(
      "Webhook processed.",
      {
        status: 200
      }
    );

  } catch (error) {
    console.error(
      "Stripe webhook error:",
      error
    );

    return new Response(
      "Webhook error.",
      {
        status: 500
      }
    );
  }
}


/* =========================
   STRIPE SIGNATURE VERIFY
========================= */

async function verifyStripeSignature(
  payload,
  signatureHeader,
  secret
) {

  try {
    const parts =
      signatureHeader
        .split(",")
        .map(
          part =>
            part.trim()
        );


    let timestamp = null;

    const signatures = [];


    for (const part of parts) {

      const separatorIndex =
        part.indexOf("=");


      if (
        separatorIndex === -1
      ) {
        continue;
      }


      const key =
        part.slice(
          0,
          separatorIndex
        );


      const value =
        part.slice(
          separatorIndex + 1
        );


      if (
        key === "t"
      ) {
        timestamp =
          value;
      }


      if (
        key === "v1"
      ) {
        signatures.push(
          value
        );
      }

    }


    if (
      !timestamp ||
      signatures.length === 0
    ) {
      return false;
    }


    const currentTime =
      Math.floor(
        Date.now() / 1000
      );


    const webhookTime =
      Number(timestamp);


    if (
      !Number.isFinite(webhookTime)
    ) {
      return false;
    }


    if (
      Math.abs(
        currentTime -
        webhookTime
      ) > 300
    ) {
      return false;
    }


    const signedPayload =
      `${timestamp}.${payload}`;


    const encoder =
      new TextEncoder();


    const cryptoKey =
      await crypto.subtle.importKey(
        "raw",
        encoder.encode(secret),
        {
          name:
            "HMAC",

          hash:
            "SHA-256"
        },
        false,
        [
          "sign"
        ]
      );


    const signatureBuffer =
      await crypto.subtle.sign(
        "HMAC",
        cryptoKey,
        encoder.encode(
          signedPayload
        )
      );


    const expectedSignature =
      Array.from(
        new Uint8Array(
          signatureBuffer
        )
      )
        .map(
          byte =>
            byte
              .toString(16)
              .padStart(2, "0")
        )
        .join("");


    return signatures.some(
      signature =>
        timingSafeEqual(
          expectedSignature,
          signature
        )
    );

  } catch (error) {

    console.error(
      "Signature verification error:",
      error
    );

    return false;

  }
}


/* =========================
   TIMING SAFE STRING CHECK
========================= */

function timingSafeEqual(
  valueA,
  valueB
) {

  if (
    valueA.length !==
    valueB.length
  ) {
    return false;
  }


  let result = 0;


  for (
    let i = 0;
    i < valueA.length;
    i++
  ) {

    result |=
      valueA.charCodeAt(i) ^
      valueB.charCodeAt(i);

  }


  return result === 0;
}
