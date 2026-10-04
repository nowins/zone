import assert from "node:assert/strict";
import test from "node:test";
import {parsePodcastNotes,safePodcastLink,podcastTimecodeSeconds} from "../.tmp/visualizer-tests/utils/podcastNotes.js";
const flatten=nodes=>nodes.flatMap(node=>node.type==="text"?[node]:[node,...flatten(node.children)]);
test("plain RSS paragraphs, line breaks and HTML lists retain separate reading blocks", () => {
 const plain=parsePodcastNotes('第一段\n同段第二行\n\n第二段\n\nhttps://example.com/notes');
 assert.equal(plain.length,3); assert.ok(plain.every(node=>node.tag==='p'));
 assert.ok(flatten(plain[0].children).some(node=>node.text?.includes('第一段\n同段第二行')));
 const html=parsePodcastNotes('<p>第一段<p>第二段</p><ul><li>一<li>二</ul><blockquote>引用\n\n下一段</blockquote>');
 assert.deepEqual(html.map(node=>node.tag),['p','p','ul','blockquote']);
 assert.equal(html[2].children.filter(node=>node.tag==='li').length,2);
 assert.equal(html[3].children.filter(node=>node.tag==='p').length,2);
});
test("shownotes preserve reading structure while discarding executable and remote embed markup",()=>{
 const nodes=flatten(parsePodcastNotes('<p onclick="alert(1)">中文 &amp; 简介 <strong>重点</strong><script>alert(1)</script><img src="https://evil.example/track"><a href="javascript:alert(1)">坏链接</a><a href="/notes#part">资料</a></p>',"https://example.com/show"));
 assert.equal(nodes.some(node=>node.tag==="script"||node.tag==="img"),false);assert.equal(nodes.some(node=>node.text?.includes("alert(1)")),false);
 assert.ok(nodes.some(node=>node.tag==="strong"));assert.ok(nodes.some(node=>node.href==="https://example.com/notes#part"));
 assert.equal(nodes.filter(node=>node.href).length,1);assert.ok(nodes.some(node=>node.text?.includes("中文 & 简介")));
});
test("plain URLs are actionable, punctuation remains text, and encoded unsafe URLs cannot become links",()=>{
 const nodes=flatten(parsePodcastNotes('查看 https://example.com/notes。 <a href="j&#x61;vascript:alert(1)">坏链接</a>'));
 assert.equal(nodes.find(node=>node.href)?.href,"https://example.com/notes");assert.ok(nodes.some(node=>node.text?.includes("。")));
 for(const url of ["file:///secret","javascript:alert(1)","https://localhost./","http://127.0.0.1/","https://user:password@example.com","https://example.com:8443"])assert.equal(safePodcastLink(url),null);
 assert.equal(podcastTimecodeSeconds("1:02:03"),3723);assert.equal(podcastTimecodeSeconds("02:30"),150);assert.equal(podcastTimecodeSeconds("1:61:00"),null);assert.equal(podcastTimecodeSeconds("2:60"),null);
});
