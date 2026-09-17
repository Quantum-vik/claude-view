import json, pathlib
tpl = pathlib.Path("template.html").read_text()
fx  = pathlib.Path("fixture.json").read_text()
out = tpl.replace("/*__FIXTURE__*/null", fx)
pathlib.Path("index.html").write_text(out)
print("index.html", len(out)//1024, "KB")
