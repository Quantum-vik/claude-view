import json, pathlib
here = pathlib.Path(__file__).parent
tpl = (here / "template.html").read_text()
fx = (here / "fixture.json").read_text()
(here / "index.html").write_text(tpl.replace("/*__FIXTURE__*/null", fx))
print("index.html", len((here / "index.html").read_text()) // 1024, "KB")
