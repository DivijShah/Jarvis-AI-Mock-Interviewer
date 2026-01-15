export async function POST(req: Request) {
  const { answer } = await req.json();

  if (!answer) {
    return Response.json(
      { error: "Answer is required" },
      { status: 400 }
    );
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return Response.json(
      { error: "OPENAI_API_KEY missing" },
      { status: 500 }
    );
  }

  const openaiRes = await fetch(
    "https://api.openai.com/v1/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.7,
        messages: [
          {
            role: "system",
            content:
              "You are Jarvis, a senior software engineering interviewer. Ask one follow up question and give short feedback."
          },
          {
            role: "user",
            content: answer
          }
        ]
      })
    }
  );

  const data = await openaiRes.json();

  // 🔴 ADD THIS BLOCK (quota + safety handling)
  if (data.error) {
    console.error("OpenAI error:", data.error);

    if (data.error.code === "insufficient_quota") {
      return Response.json(
        {
          error:
            "AI service quota exceeded. Please add billing or try again later."
        },
        { status: 503 }
      );
    }

    return Response.json(
      { error: "AI service error", details: data.error.message },
      { status: 500 }
    );
  }

  if (!data.choices || !data.choices[0]) {
    console.error("Unexpected OpenAI response:", data);
    return Response.json(
      { error: "Invalid response from AI service" },
      { status: 500 }
    );
  }

  return Response.json({
    interviewer: data.choices[0].message.content
  });
}
