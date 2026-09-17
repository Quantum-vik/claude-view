# Prototype: panel-first layout (issue #17)

Throwaway. Answers "what does the window look like when the terminal is collapsed
and the panel is the whole view?"

    python3 gen_fixture.py   # builds fixture.json from a real local transcript, redacted
    python3 build.py         # inlines it into index.html
    xdg-open index.html

`fixture.json` and `index.html` are gitignored: they carry real session content.
The generator and the template are the committed artifacts, so anyone can rebuild.
