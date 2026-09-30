const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Element {
  constructor(tag = "div") {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this.dataset = {};
    this.attributes = {};
    this.className = "";
    this.textContent = "";
    this.value = "";
    this.checked = true;
    this.hidden = false;
    this.classList = {
      toggle: (name, enabled) => {
        const classes = new Set(this.className.split(" ").filter(Boolean));
        if (enabled) classes.add(name);
        else classes.delete(name);
        this.className = [...classes].join(" ");
      }
    };
  }
  append(...elements) { this.children.push(...elements); }
  replaceChildren(...elements) { this.children = [...elements]; }
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
  setAttribute(name, value) { this.attributes[name] = value; }
  showModal() { this.open = true; }
  close() { this.open = false; }
  click() { for (const listener of this.listeners.click || []) listener({target:this}); }
  change() { for (const listener of this.listeners.change || []) listener({target:this}); }
  input() { for (const listener of this.listeners.input || []) listener({target:this}); }
}

function setup() {
  const ids = {};
  const element = id => ids[id] ||= new Element();
  const tabs = ["map", "flows", "states", "review"].map(name => {
    const tab = new Element("button"); tab.dataset.tab = name; return tab;
  });
  const filters = ["all", "covered", "partial", "missing"].map(name => {
    const filter = new Element("button"); filter.dataset.stateFilter = name; return filter;
  });
  const choices = ["keep", "change", "add", "defer"].map(name => {
    const choice = new Element("button"); choice.dataset.choice = name; return choice;
  });
  const saved = {};
  const document = {
    body: new Element("body"),
    getElementById: element,
    createElement: tag => new Element(tag),
    querySelectorAll: selector => ({"[data-tab]":tabs,"[data-state-filter]":filters,"[data-choice]":choices}[selector] || [])
  };
  const context = {
    document, console, Blob, Date, setTimeout,
    localStorage: {getItem:key=>saved[key] || null,setItem:(key,value)=>saved[key]=value},
    URL: {createObjectURL:()=>"blob:test",revokeObjectURL:()=>{}}
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"app.js"),"utf8"),context);
  return {element,tabs,filters,choices,saved};
}

test("sitemap, flows, and 26 states render; proposed overlay toggles", () => {
  const {element} = setup();
  assert.equal(element("map").children.length,6);
  assert.equal(element("flowList").children.length,7);
  assert.equal(element("stateRows").children.length,26);
  const countItems = () => element("map").children.reduce((count,group)=>count+group.children[1].children.length,0);
  assert.equal(countItems(),16);
  element("showFuture").checked=false;
  element("showFuture").change();
  assert.equal(countItems(),10);
});

test("area review and state filter update without touching product data", () => {
  const {element,tabs,filters,choices,saved} = setup();
  const entryGroup=element("map").children[0];
  entryGroup.children[1].children[0].click();
  assert.equal(element("detailDialog").open,true);
  assert.equal(element("detailTitle").textContent,"Sign in / out");
  assert.match(element("detailReason").textContent,/entry screen assumes/);
  assert.equal(element("detailOptions").children.length,2);
  element("detailOptions").children[0].click();
  choices[1].click();
  element("reviewNote").value="Clarify first use";
  element("reviewNote").input();
  assert.equal(element("reviewCount").textContent,1);
  assert.match(Object.values(saved)[0],/Clarify first use/);
  assert.match(Object.values(saved)[0],/"direction":"guided"/);
  tabs[3].click();
  assert.equal(element("reviewPanel").hidden,false);
  assert.equal(element("mapPanel").hidden,true);
  filters[3].click();
  assert.ok(element("stateRows").children.length > 0);
  assert.ok(element("stateRows").children.length < 26);
});

test("every map destination has a concrete question and selectable directions", () => {
  const {element} = setup();
  const cards=element("map").children.flatMap(group=>group.children[1].children);
  assert.equal(cards.length,16);
  for(const card of cards){
    card.click();
    assert.ok(element("detailQuestion").textContent.length > 50);
    assert.ok(element("detailRecommendation").textContent.length > 40);
    assert.ok(element("detailOptions").children.length >= 2);
    element("detailDialog").close();
  }
  const firstState=element("stateRows").children[0];
  assert.match(firstState.children[0].children[0].textContent,/Example:/);
});
