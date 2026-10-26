import { describe, expect, it } from "vitest";
import { decodeEntities, findText, htmlToText } from "./text";

describe("htmlToText", () => {
  it("drops scripts and tags, keeps words apart at block boundaries, decodes entities", () => {
    const html = `<html><head><style>p{}</style><script>var GPTBot = 1;</script></head>
      <body><h1>Bots</h1><p>The <code>ExampleBot</code> crawler&nbsp;respects
      robots.txt.</p><p>It doesn&#x27;t &amp; won&rsquo;t</p><!-- hidden --></body></html>`;
    expect(htmlToText(html)).toBe(
      "Bots The ExampleBot crawler respects robots.txt. It doesn't & won’t",
    );
  });

  it("decodes numeric and named entities and leaves unknown ones", () => {
    expect(decodeEntities("&#8220;hi&#8221; &#x2014; &bogus;")).toBe("“hi” — &bogus;");
  });
});

describe("findText", () => {
  const page = "OAI-SearchBot is for search. It won’t be used to train models.";

  it("finds verbatim text across whitespace differences", () => {
    expect(findText("OAI-SearchBot  is\nfor search.", page)).toBe("verbatim");
  });

  it("reports matches that need punctuation folding separately", () => {
    expect(findText("It won't be used", page)).toBe("punctuation");
  });

  it("does not find text that is not there", () => {
    expect(findText("is used to train models", page)).toBe("not_found");
  });
});
