import json, pathlib
here = pathlib.Path(__file__).parent
tpl = (here / "template.html").read_text()
fx  = (here / "fixture.json").read_text()
out = tpl.replace("/*__FIXTURE__*/null", fx)
(here / "index.html").write_text(out)
print("index.html", len(out)//1024, "KB")
