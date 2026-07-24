"""The narrative brain. Swappable behind one interface so Ollama (local/free),
Claude (paid/best), and a no-LLM template fallback are interchangeable via config.

Hard rule enforced here: the brain only turns ALREADY-COMPUTED numbers + events
into prose. It is never given the job of computing weights, exposure, or scores,
and the system prompt forbids buy/sell recommendations.
"""
