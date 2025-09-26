class JSBinder
{
    // let myJSBinder = new JSBinder();
    constructor(options = {})
    {
        if (!JSBinder.#isPlainObject(options))
            return JSBinder.#error(`options must be an object`);

        this.#settings = { root: document.body, prefix: "", highFrequencyInterval: 100, lowFrequencyInterval: 5000, interpolation: ["{{", "}}"], ...options };
        
        if (!this.#settings.root)
            return JSBinder.#error('JSBinder can not find the root element');

        if (this.#settings.root.attributes.hasOwnProperty("data-jsbinder"))
            return JSBinder.#error('an instance of JSBinder already exists on this root');

        this.#settings.root.dataset.jsbinder = "";

        this.#abortController = new AbortController();

        this.#highFrequencyController.start(this.#settings.highFrequencyInterval);
        this.#lowFrequencyController.start(this.#settings.lowFrequencyInterval);
    };

    #abortController;
    #settings;


    // Utils

    static #error = (msg) => console.error(`JSBinder: ${msg}`);
    static #info = (msg) => console.info(`JSBinder: ${msg}`);
    static #warn = (msg) => console.warn(`JSBinder: ${msg}`);

    static #listOrSingle = (x) => (Array.isArray(x) && x.length === 1) ? x[0] : x;

    static #isPlainObject = (obj) => obj !== null && typeof obj === 'object' && !Array.isArray(obj);
    static #isEmpty = (x) => [undefined, null, ""].includes(x);

    static #toKebabCase = (text) => text.trim().replace(new RegExp("([a-z])([A-Z])", "g"), (_, a, b) => `${a}-${b.toLowerCase()}`); // "marginTop" >> "margin-top"
    static #toCamelCase = (text) => text.trim().replace(new RegExp("([a-z])-([a-z])", "g"), (_, a, b) => `${a}${b.toUpperCase()}`); // "margin-top" >> "marginTop"

    static #pop = (obj) => (...keys) => JSBinder.#listOrSingle(keys.map(key => { const data = obj.dataset[JSBinder.#toCamelCase(key)]?.trim().replace(new RegExp("\\s\\s+", "g"), " ") ?? null; obj.removeAttribute(`data-${key}`); return data; }));
    static #split = (input) => input.split(";").map(x => x.trim()).filter(x => x !== "");

    static #cleanHTML = (html) => html.trim().replace(new RegExp("\\<!--[\\s\\S]*?--\\>", "g"), "").replace(new RegExp("\\s\\s+", "g"), " ");

    static #replaceObject = (obj) => (...objs) => { obj.replaceWith(...objs); return JSBinder.#listOrSingle(objs); };

    static #deserializeHTML = (html) => { let t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };

    // ".*+" >> "\\.\\*\\+"
    static #escapeRgx = (string) => string.replace(new RegExp("[.*+?^${}()|\\[\\]\\\\]", "g"), '\\$&');

    // Left-to-right function composition. JSBinder.#pipe(f1, f2, f3)(x) >> f3(f2(f1(x)));
    static #pipe = (...fns) => (x) => fns.reduce((v, f) => f(v), x);

    static #alphaNumericSort = (() => {
        const isNumeric = (val) => typeof val === 'number' || (!isNaN(val) && !isNaN(parseFloat(val)));
        return (a, b) => {
            const aIsNum = isNumeric(a);
            const bIsNum = isNumeric(b);
            if (aIsNum && !bIsNum) return 1;
            if (!aIsNum && bIsNum) return -1;
            if (aIsNum && bIsNum) return parseFloat(a) - parseFloat(b);
            return a.toString().localeCompare(b.toString(), undefined, { numeric: true, sensitivity: 'base' });
        };
    })();


    // State handling

    #indexMap = new Map();
    #state = {};
    #functions = {};

    // myJSBinder.setState({ list: ["A", "B"], title: "Abcde" });
    // myJSBinder.setState((current) => ({ items : [...current.items, "new item"] }));
    //
    // Object must not be fully defined. Update is adds/modifies specified members.
    // Setting a member to 'undefined' removes it from the state.
    setState = (data) => {
        if (typeof data === "function" && data.length === 1) data = data(this.#state);

        if (!JSBinder.#isPlainObject(data))
            return JSBinder.#error(`setState requires an object or a function with a single attribute returning an object as input`);

        const recurse = (state, updates) => {
            Object.keys(updates).forEach((key) => { if (updates[key] === undefined) { delete state[key]; } else { state[key] = JSBinder.#isPlainObject(updates[key]) ? recurse(state[key] || {}, updates[key]) : updates[key]; } });
            return state;
        };

        this.#state = recurse(this.#state, data);
        this.#updateRequest = true;
    };

    getState = () => this.#state;
    
    // Creates a path from expression. "data[0].title" >> ["data", 0, "title"]
    #createPath = (exp) => exp
        .replace(new RegExp("\\{([a-zA-Z0-9\\-_]+)\\}", "g"), (_, key) => this.#indexMap.get(key)) // "{index_key}" >> index.
        .replace(new RegExp("\\[(\\d+)\\]", "g"), ".$1.") // array[1] >> array.1.
        .replace(new RegExp("\\.+", "g"), ".") // ".." >> "."
        .replace(new RegExp("^\\.", "g"), "") // ".aa.bb" >> "aa.bb"
        .replace(new RegExp("\\.$", "g"), "") // "aa.bb." >> "aa.bb"
        .split(".");

    #get = (exp) => {
        if (typeof exp !== "string") return exp; // true / false / null / undefined / numeric... etc.

        exp = exp.trim();

        if (exp.match(new RegExp("^-?[0-9]+$"))) return parseInt(exp); //int
        if (exp.match(new RegExp("^-?[0-9]+\\.[0-9]+$"))) return parseFloat(exp); //float
        if (exp.match(new RegExp("^" + `(['"])` + ".*" + "\\1" + "$"))) return exp.substr(1,exp.length-2); //string ('text' or "text")
        if (exp === "true") return true;
        if (exp === "false") return false;
        if (exp === "null") return null;
        if (exp === "undefined") return undefined;
        if (exp === "Infinity") return Infinity;
        if (exp === "NaN") return NaN;

        return this.#createPath(exp).reduce((x, key) => (x === undefined || x[key] === undefined) ? undefined : x[key], this.#state);
    };

    #set = (exp, value) => {
        const path = this.#createPath(exp.trim());
        const key = path.pop();

        const target = path.reduce((x, key) => (x === undefined || x[key] === undefined) ? undefined : x[key], this.#state);
        if (target) {
            target[key] = value;
            this.#updateRequest = true;
        }
    };

    // myJSBinder.addFunction("round", (x) => Math.round(x)); >> <span>{{#round(5.55)}}</span> >> <span>6</span>
    // myJSBinder.addFunction("abs", function (x) { return Math.abs(x) });
    addFunction = (name, method) => {
        if (!name.match(new RegExp("^" + JSBinder.#RGX_VAR + "$")))
            return JSBinder.#error(`addFunction 'name' must match '${JSBinder.#RGX_VAR}'`);

        if (typeof method !== "function" || method.length !== 1)
            return JSBinder.#error(`addFunction 'method' must be a function with a single argument`);

        this.#functions = { ...this.#functions, ["#"+name]: method };
    };


    static #ExpressionTree = class {
        #binder;
        #tree;

        constructor (binder, exp)
        {
            this.#binder = binder;
            this.#tree = JSBinder.#ExpressionTree.#buildTree(exp);
        };

        static #operators = ["?", ":", "(", ")", "!!", "!", "~", "<<", ">>", ">>>", "**", "*", "/", "%", "+", "-", ">=", ">", "<=", "<", "===", "==", "!==", "!=", "&", "^", "|", "&&", "||", "??"];
        static #rgxAnyOperator = new RegExp("(" + this.#operators.sort((a,b) => b.length - a.length).map(JSBinder.#escapeRgx).join("|") + ")", "g");

        static #isFunction = (x) => typeof x === "string" && !!x.match(new RegExp("^" + "#" + JSBinder.#RGX_VAR + "$"));
        static #isOperator = (x) => typeof x === "string" && this.#operators.includes(x);

        // Recusive parse and build an expression tree / Abstract Syntax Tree (AST) from an string expression in order of operator precedence.
        static #buildTree = (exp) => {
            const stringMap = new Map();

            //"..." & '...' >> "{{index}}" Replaces strings in expression and store temporary.
            [...String(exp).matchAll(new RegExp(["'[^']*'", "\"[^\"]*\""].join("|"), "g"))].forEach(([text], index) => {
                stringMap.set(index, text);
                exp = exp.replace(text, `{{${index}}}`);
            });

            let parts = exp.replace(this.#rgxAnyOperator, " $1 ").trim().split(new RegExp("\\s+"));

            //"{{index}}" >> "..." & '...' Restore strings in expression.
            parts = parts.map((x) => {
                const m = x.match(new RegExp("^" + "\\{\\{([0-9]+)\\}\\}" + "$"));
                if (m) return stringMap.get(parseInt(m[1])); // lägg till " ?? 'undefined_temp_value'" etc..?
                return x;
            });

            let pos = 0;

            const recurse = () => {
                let output = [];

                // ["(", "1", "+", "1", ")", "/", "2"] >> [["1", "+", "1"], "/", "2"]
                while (pos < parts.length) {
                    if (parts[pos] === "(") { pos++; output.push(JSBinder.#listOrSingle(recurse())); }
                    else if (parts[pos] === ")") { pos++; break; }
                    else { output.push(parts[pos]); pos++ }
                }

                // (right to left) (..., operator) "-", "5", ... >> (..., operator) ["-", "5"], ...
                for (let x = output.length - 2; x >= 0; x--)
                    if (["-", "+"].includes(output[x]) && (x === 0 || JSBinder.#ExpressionTree.#isOperator(output[x-1])))
                        output.splice(x, 2, [output[x], output[x+1]]);

                // (right to left) ..., unary_operator, operand, ... >> ..., [unary_operator, operand], ...
                // ["false", "===", "!", "true"] >> ["false", "===", ["!", "true"]]
                // ["false", "===", "!", "!", "true"] >> ["false", "===", ["!", ["!", "true"]]]
                for (let x = output.length - 2; x >= 0; x--)
                    if (["!!", "!", "~"].includes(output[x]))
                        output.splice(x, 2, [output[x], output[x+1]]);
        
                // (right to left) ..., operand, binary_operator, operand, ... >> ..., [operand, binary_operator, operand], ...
                for (let x = output.length - 3; x >= 0; x--)
                    if (["**"].includes(output[x+1]))
                        output.splice(x, 3, [output[x], output[x+1], output[x+2]]);

                // (left to right) ..., operand, binary_operator, operand, ... >> ..., [operand, binary_operator, operand], ...
                // ["4", "/", "2", "+", "2", "*", "4", "==", "10"] >> [[["4", "/", "2"], "+", ["2", "*", "4"]], "==", "10"]
                [["*", "/", "%"], ["+", "-"], ["<<", ">>", ">>>"], [">=", ">", "<=", "<"], ["===", "==", "!==", "!="], ["&"], ["^"], ["|"], ["&&"], ["||"], ["??"]].forEach((ops) => {
                    let x = 0;
                    while (output.length > 3 && x <= output.length - 3)
                        if (ops.includes(output[x+1])) { output.splice(x, 3, [output[x], output[x+1], output[x+2]]); } else { x++ };
                });

                // (right to left) ..., [1, "==", 2], "?", "'Yes'", ":", "'No'", ... >> ..., [[1, "==", 2], "?", "'Yes'", ":", "'No'"], ...
                for (let x = output.length - 5; x >= 0; x--)
                    if (output[x+1] === "?" && output[x+3] === ":")
                        output.splice(x, 5, [output[x], "?", output[x+2], ":", output[x+4]]);

                // Make sure to not return nested lists if not needed.
                // [[...]] >> [...]
                return output.length === 1 && Array.isArray(output[0]) ? output[0] : output;
            };

            return recurse();
        };

        // Evaluates unary expressions. Ex: '!true' (operator operand)
        // map: [['!', (a) => !a], ...] data: ['!', true] >> [false]
        static #evaluateUnaryOperations = (data, map) => {
            map.forEach(([op, func]) => { if (data.length === 2 && data[0] === op) { data = [func(data[1])]; } });
            return data;
        };

        // Evaluates binary expressions. Ex: '1+2' (operand operator operand)
        // map: [['+', (a, b) => a+b], ...] data: [1, '+', 2] >> [3]
        static #evaluateBinaryOperations = (data, map) => {
            map.forEach(([op, func]) => { if (data.length === 3 && data[1] === op) { data = [func(data[0], data[2])]; } });
            return data;
        };

        // Recursive evaluation of expression tree.
        evaluate = () => {
            // [[1, "==", 2], "?", "'yes'", ":", "'no'" ] >> ["'no'"]
            const handleTernary = (data) => {
                const list = (x) => Array.isArray(x) ? x : [x];

                if (data.length === 5 && data[1] === "?" && data[3] === ":") data = evaluateTree(list(data[0])) ? list(data[2]) : list(data[4]);
                return data;
            };

            // [#round, 5.5] >> [6]
            const handleFunctions = (data) =>
                JSBinder.#ExpressionTree.#evaluateUnaryOperations(data, Object.entries(this.#binder.#functions)); //Object.entries(...) >> [["#round", (x) => Math.round(x)], ...]

            // ["!", true] >> [false]
            const handleUnaryOperations = (data) => 
                JSBinder.#ExpressionTree.#evaluateUnaryOperations(data, [
                    ["!!", (x) => !!x],
                    ["!",  (x) =>  !x],
                    ["~",  (x) =>  ~x],
                    ["-",  (x) => 0-x],
                    ["+",  (x) => 0+x],
                ]);

            // [1, "+", 2] >> [3]
            const handleBinaryOperations = (data) =>
                JSBinder.#ExpressionTree.#evaluateBinaryOperations(data, [
                    ["**",  (x, y) => x **  y], 
                    ["*",   (x, y) => x *   y], 
                    ["/",   (x, y) => x /   y], 
                    ["%",   (x, y) => x %   y], 
                    ["+",   (x, y) => x +   y], 
                    ["-",   (x, y) => x -   y], 
                    ["<<",  (x, y) => x <<  y],
                    [">>",  (x, y) => x >>  y],
                    [">>>", (x, y) => x >>> y],
                    ["===", (x, y) => x === y],
                    ["==",  (x, y) => x ==  y],
                    ["!==", (x, y) => x !== y],
                    ["!=",  (x, y) => x !=  y],
                    [">=",  (x, y) => x >=  y],
                    [">",   (x, y) => x >   y],
                    ["<=",  (x, y) => x <=  y],
                    ["<",   (x, y) => x <   y],
                    ["&",   (x, y) => x &   y],
                    ["^",   (x, y) => x ^   y],
                    ["|",   (x, y) => x |   y],
                    ["&&",  (x, y) => x &&  y],
                    ["||",  (x, y) => x ||  y],
                    ["??",  (x, y) => x ??  y],
                ]);

            // Recursive parse tree nodes to values.
            // ["'string'", vaiable_eq_1, "true", ...] >> ["string", 1, true, ...]   
            const resolveLiterals = (input) => input
                .map((x) => Array.isArray(x) ? resolveLiterals(x) : x)
                .map((x) => !Array.isArray(x) && !JSBinder.#ExpressionTree.#isFunction(x) && !JSBinder.#ExpressionTree.#isOperator(x) ? this.#binder.#get(x) : x);

            // Recursive solve tree.
            const evaluateTree = (input) => JSBinder.#pipe(handleTernary, handleFunctions, handleUnaryOperations, handleBinaryOperations, JSBinder.#listOrSingle)(input.map((x) => Array.isArray(x) ? evaluateTree(x) : x));

            return JSBinder.#pipe(resolveLiterals, evaluateTree)(this.#tree);
        };
    };

    #evaluate = (expression) => (new JSBinder.#ExpressionTree(this, expression)).evaluate();


    static #Type = { CHECKBOX: "checkbox", INPUT: "input", SELECT: "select", IMG: "img", IFRAME: "iframe" };

    static #typeOf = (obj) => {
        if (obj.matches("input[type='checkbox']")) return JSBinder.#Type.CHECKBOX;
        if (obj.matches("input")) return JSBinder.#Type.INPUT;
        if (obj.matches("select")) return JSBinder.#Type.SELECT;
        if (obj.matches("img")) return JSBinder.#Type.IMG;
        if (obj.matches("iframe")) return JSBinder.#Type.IFRAME;
        return null;
    };


    static #RGX_VAR = "[a-zA-Z]{1}[0-9a-zA-Z_]*";
    static #RGX_CLASS = "[a-zA-Z]{1}[0-9a-zA-Z_-]*";
    static #RGX_ATTR = "[a-zA-Z]{1}[0-9a-zA-Z_-]*";
    static #RGX_INT = "[0-9]+";
    static #RGX_INDEX_KEY = "{[a-zA-Z0-9_]+\\}";
    static #RGX_EXP = ".+?";
    static #RGX_PATH = JSBinder.#RGX_VAR + "(?:" + "(?:" + [`\\[${JSBinder.#RGX_INT}\\]`, `\\[@${JSBinder.#RGX_VAR}\\]`, `\\[${JSBinder.#RGX_INDEX_KEY}\\]`, "\\."].join("|") + ")" + `(?:${JSBinder.#RGX_VAR})?` + ")*";

    static #rgxFormatVariable = (key) => new RegExp("@" + key + "\\b", "g");


    // Returns attributes with prefix (if defined).
    #mapAttributes = (...keys) => JSBinder.#listOrSingle(keys.map(key => (this.#settings.prefix ? `${this.#settings.prefix}-` : "") + key));

    // Helper function to find directives in the DOM not inside a template or other directive.
    #findDirectives = (directive, selector  = "") => (callback) => {
        const [$if, $each, $for] = this.#mapAttributes("if", "each", "for");
        [...this.#settings.root.querySelectorAll(`${selector}[data-${directive}]`)]
            .filter((obj) => ![`[data-${$if}]`, `[data-${$each}]`, `[data-${$for}]`, `template`].some(x => !!obj.parentNode.closest(x)))
            .filter((obj) => obj.closest("[data-jsbinder]") === this.#settings.root)
            .forEach((obj) => callback(obj));
    };

    // Helper function to find childNodes of parent not inside a template or other directive.
    #findChildNodes = (parent) => (callback) => {
        const [$if, $each, $for] = this.#mapAttributes("if", "each", "for");
        [...parent.childNodes]
            .filter((obj) => obj.nodeType !== Node.ELEMENT_NODE || ![`[data-${$if}]`, `[data-${$each}]`, `[data-${$for}]`, `template`].some(x => !!obj.matches(x)))
            .filter((obj) => obj.nodeType !== Node.ELEMENT_NODE || !obj.matches("[data-jsbinder]"))
            .forEach((obj) => callback(obj));
    };

    // Helper function to dispatch custom JSBinder events.
    #dispatchEvent = (obj, type, detail = {}) => obj.dispatchEvent(new CustomEvent(`jsbinder-${type}`, { 'bubbles': true, 'detail': detail }));

    // Memoization of last value to check if it has changed.
    // let memo = new JSBinder.#ModifiedMemo();
    // memo.check(data) >> boolean (true on first call or if data is different from last check.)
    static #ModifiedMemo = class { #current = null; #first = true; check = (value) => { if (this.#first === true || value !== this.#current) { this.#current = value; this.#first = false; return true; } return false; } };

    // data-if="data.visible == true"
    // data.visible = true  >> <div data-if="data.visible == true">a</div> >> <div>a</div>
    // data.visible = false >> <div data-if="data.visible == true">a</div> >> <!-- if -->
    //
    // event: jsbinder-if with e.detail.action = "add" / "remove".
    #ifDirective = ((binder) => new class {
        #items = [];
        #cleanup = () => { this.#items = this.#items.filter((x) => document.body.contains(x.obj)); };

        scan = () => {
            this.#cleanup();

            const $if = binder.#mapAttributes("if");

            binder.#findDirectives($if)
                ((obj) => {
                    const expression = JSBinder.#pop(obj)($if);
                    const html = JSBinder.#cleanHTML(obj.outerHTML);
                    const placeholder = JSBinder.#replaceObject(obj)(document.createComment("if"));

                    this.#items.push({
                        obj: placeholder, 
                        html, 
                        expressionTree: new JSBinder.#ExpressionTree(binder, expression), 
                        modified: new JSBinder.#ModifiedMemo(),
                    });
                });
        };

        update = () => {
            let counter = 0;

            this.#items.forEach((item) => {
                const result = !!item.expressionTree.evaluate();
                if (item.modified.check(result)) {
                    if (result === true) {
                        item.obj = JSBinder.#replaceObject(item.obj)(JSBinder.#deserializeHTML(item.html));
                        binder.#dispatchEvent(item.obj, "if", { action: "add" });
                        counter++;
                    } else {
                        binder.#dispatchEvent(item.obj, "if", { action: "remove" });
                        item.obj = JSBinder.#replaceObject(item.obj)(document.createComment("if"));
                    }
                }
            });

            return counter;
        };
    })(this);

    // data-each="@item in items" data-key="@item..." [data-where="..."] [data-skip="..."] [data-limit="..."] [data-orderby="..."] [data-distinct="..."]
    //
    // { items: ["a", "b", ...] }      >> <p data-each="@item in items" data-key="@item">{{@item}}</p>                                        >> <p>a</p><p>b</p>...
    // { items: [{title: "a"}, ...] }  >> <p data-each="@item in items" data-key="@item.title">{{@item.title}}</p>                            >> <p>a</p>...
    // { numbers: [1,2,3,4,5, ...] }   >> <p data-each="@number in numbers" data-key="@number" data-where="@number > 3">{{@number}}</p>       >> <p>4</p><p>5</p>...
    // { numbers: [1,2,3,4,5, ...] }   >> <p data-each="@number in numbers" data-key="@number" data-skip="1" data-limit="2">{{@number}}</p>   >> <p>2</p><p>3</p>
    //
    // event: jsbinder-each with e.detail.action = "add" / "remove".
    #eachDirective = ((binder) => new class {
        #items = [];
        #cleanup = () => { this.#items = this.#items.filter((x) => document.body.contains(x.start)); };
        #index = 0;

        scan = () => {
            this.#cleanup();

            const [$each, $key, $where, $skip, $limit, $orderby, $distinct] = binder.#mapAttributes("each", "key", "where", "skip", "limit", "orderby", "distinct");

            binder.#findDirectives($each)
                ((obj) => {
                    const [expression, key, where, skip, limit, orderby, distinct] = JSBinder.#pop(obj)($each, $key, $where, $skip, $limit, $orderby, $distinct);
                    const html = JSBinder.#cleanHTML(obj.outerHTML);
                    const [start, end] = JSBinder.#replaceObject(obj)(document.createComment("each"), document.createComment("/each"));

                    if (key === null)
                        return JSBinder.#error("'each' must have 'key' expression defined");

                    const m = expression.match(new RegExp("^" + `@(${JSBinder.#RGX_VAR})` + "\\s+" + "in" + "\\s+" + "(" + JSBinder.#RGX_PATH + ")" + "$"));

                    if (!m)
                        return JSBinder.#error(`incorrect 'each' expression: ${expression}`);

                    const { 1: alias, 2: list } = m;
                    this.#items.push({
                        itemIndex: this.#index++,
                        html, 
                        key, 
                        keys: [], 
                        objs: [], 
                        start, 
                        end, 
                        alias, 
                        list, 
                        where,
                        orderby,
                        distinct,
                        limitTree: limit !== null ? new JSBinder.#ExpressionTree(binder, limit) : null,
                        skipTree: skip !== null ? new JSBinder.#ExpressionTree(binder, skip) : null,
                    });
                });
        };

        update = () => {
            let counter = 0;

            this.#items.forEach((item) => {
                const whereNotIn = (other) => (x) => !other.includes(x);
                const whereNotNull = (x) => x !== null;

                const skip = item.skipTree !== null ? item.skipTree.evaluate() : null;
                const limit = item.limitTree !== null ? item.limitTree.evaluate() : null;

                let indexes = [];
                
                // Create list of all idexes to include, filtered by 'where' if defined.
                const source = binder.#get(item.list);
                if (Array.isArray(source)) {
                    source.forEach((x, index) => {
                        const valid = item.where === null || binder.#evaluate(item.where.replace(JSBinder.#rgxFormatVariable(item.alias), `${item.list}[${index}]`));
                        if (valid) indexes.push(index);
                    });
                }

                // Sort list of indexes if 'orderby' is defined.
                if (item.orderby !== null) {
                    indexes = indexes
                        .map(index => ({ index, value : binder.#evaluate(item.orderby.replace(JSBinder.#rgxFormatVariable(item.alias), `${item.list}[${index}]`)) }))
                        .sort((a, b) => JSBinder.#alphaNumericSort(a.value, b.value))
                        .map(x => x.index);
                }

                // Filter on distinct values if 'distinct' is defined.
                if (item.distinct !== null) {
                    const distinctIndexes = Array.from(new Map(indexes.toReversed().map((index) => [binder.#evaluate(item.distinct.replace(JSBinder.#rgxFormatVariable(item.alias), `${item.list}[${index}]`)), index])).values());
                    indexes = indexes.filter((index) => distinctIndexes.includes(index));
                }

                // Reduce list of indexes if 'skip' or 'limit' is defined
                if (skip !== null) indexes = indexes.slice(skip);
                if (limit !== null) indexes = indexes.slice(0, limit);

                let newKeys = [];

                // Calculate keys for each index.
                indexes.forEach((index) => {
                    const key = binder.#evaluate(item.key.replace(JSBinder.#rgxFormatVariable(item.alias), `${item.list}[${index}]`))
                        .toString()
                        .replace(new RegExp("[^a-zA-Z0-9]", "g"), "_");

                    binder.#indexMap.set(`${item.itemIndex}_${key}`, index);

                    newKeys.push(`${item.itemIndex}_${key}`);
                });

                // Compare keys to know what to add or remove.
                const keysToRemove = item.keys.filter(whereNotIn(newKeys));
                const keysToAdd = newKeys.filter(whereNotIn(item.keys));

                // Remove existing items
                item.keys.forEach((key, i) => {
                    if (keysToRemove.includes(key)) {
                        binder.#dispatchEvent(item.objs[i], "each", { action: "remove" });
                        item.objs[i].remove();
                        item.objs[i] = null;
                        item.keys[i] = null;
                    }
                });

                // Filtered lists to not include removed elements
                let existingKeys = item.keys.filter(whereNotNull);
                let existingObjs = item.objs.filter(whereNotNull);

                let lastObj = item.start; //Store reference to element to add new items after...
                let newObjs = [];

                newKeys.forEach((key) => {
                    let obj = null;

                    if (keysToAdd.includes(key)) {
                        // Add new item
                        obj = JSBinder.#deserializeHTML(item.html.replace(JSBinder.#rgxFormatVariable(item.alias), `${item.list}[{${key}}]`));
                        lastObj.after(obj);
                        binder.#dispatchEvent(obj, "each", { action: "add" });
                        counter++;
                    } else {
                        // Reorder existing items if needed
                        const index = existingKeys.indexOf(key);
                        obj = existingObjs[index];

                        if (index > 0) lastObj.after(obj); // If object is not next of existing it needs to be moved to after "lastObj".

                        existingObjs.splice(index, 1); // Removes object from list of old objects (unhandled objects).
                        existingKeys.splice(index, 1);
                    }

                    lastObj = obj;
                    newObjs.push(obj);
                });

                item.objs = newObjs;
                item.keys = newKeys;
            });

            return counter;
        };
    })(this);

    // data-for="@value" data-from="..." data-to="..." [data-where="..."]
    //
    // <p data-for="@index" data-from="0" data-to="myArray.length">{{myArray[@index]}}</p>              >> ...
    // <p data-for="@number" data-from="3" data-to="7">{{@number}}</p>                                  >> <p>3</p><p>4</p>...<p>7</p>
    // <p data-for="@number" data-from="1" data-to="7" data-where="@number % 2 == 0">{{@number}}</p>    >> <p>2</p><p>4</p><p>6</p>
    //
    // event: jsbinder-for with e.detail.action = "add" / "remove".
    #forDirective = ((binder) => new class {
        #items = [];
        #cleanup = () => { this.#items = this.#items.filter((x) => document.body.contains(x.start)); };

        scan = () => {
            this.#cleanup();

            const [$for, $from, $to, $where] = binder.#mapAttributes("for", "from", "to", "where");

            binder.#findDirectives($for)
                ((obj) => {
                    const [expression, from, to, where] = JSBinder.#pop(obj)($for, $from, $to, $where);
                    const html = JSBinder.#cleanHTML(obj.outerHTML);
                    const [start, end] = JSBinder.#replaceObject(obj)(document.createComment("for"), document.createComment("/for"));

                    if (from === null || to === null)
                        return JSBinder.#error("'for' must have 'from' and 'to' expressions defined");

                    const m = expression.match(new RegExp("^" + `@(${JSBinder.#RGX_VAR})` + "$"));

                    if (!m)
                        return JSBinder.#error(`incorrect 'for' expression: ${expression}`);

                    const { 1: alias } = m;
                    this.#items.push({
                        html, 
                        keys: [], 
                        objs: [], 
                        start, 
                        end, 
                        alias, 
                        where,
                        fromTree: new JSBinder.#ExpressionTree(binder, from), 
                        toTree: new JSBinder.#ExpressionTree(binder, to),
                    });
                });
        };

        update = () => {
            let counter = 0;

            this.#items.forEach((item) => {
                const whereNotIn = (other) => (x) => !other.includes(x);
                const whereNotNull = (x) => x !== null;

                const from = item.fromTree.evaluate();
                const to = item.toTree.evaluate();

                let newKeys = [];
                
                // Create list of all keys/numbers to include, filtered by 'where' if defined.
                for (let key = from; key <= to; key++) {
                    const valid = item.where === null || binder.#evaluate(item.where.replace(JSBinder.#rgxFormatVariable(item.alias), key));
                    if (valid) newKeys.push(key);
                }

                // Compare keys to know what to add or remove.
                const keysToRemove = item.keys.filter(whereNotIn(newKeys));
                const keysToAdd = newKeys.filter(whereNotIn(item.keys));

                // Remove existing items
                item.keys.forEach((key, i) => {
                    if (keysToRemove.includes(key)) {
                        binder.#dispatchEvent(item.objs[i], "for", { action: "remove" });
                        item.objs[i].remove();
                        item.objs[i] = null;
                        item.keys[i] = null;
                    }
                });

                // Filtered lists to not include removed elements
                let existingKeys = item.keys.filter(whereNotNull);
                let existingObjs = item.objs.filter(whereNotNull);

                let lastObj = item.start; // Store reference to element to add new items after...
                let newObjs = [];

                newKeys.forEach((key) => {
                    let obj = null;

                    if (keysToAdd.includes(key)) {
                        // Add new item
                        obj = JSBinder.#deserializeHTML(item.html.replace(JSBinder.#rgxFormatVariable(item.alias), key));
                        lastObj.after(obj);
                        binder.#dispatchEvent(obj, "for", { action: "add" });
                        counter++;
                    } else {
                        // Existing items...
                        const index = existingKeys.indexOf(key);
                        obj = existingObjs[index];
                    }
                    
                    lastObj = obj;
                    newObjs.push(obj);
                });

                item.objs = newObjs;
                item.keys = newKeys;
            });

            return counter;
        };
    })(this);

    // <div>{{details.title}}</div>
    // <a href="{{link.url}}">{{link.title}}</a>
    // <div>{{cart.length}} {{cart.length === 1 ? "item" : "items"}} in cart.</div>
    //
    // event: jsbinder-attr with e.detail.key = attribute key and e.detail.value = value.
    //        jsbinder-bind with e.detail.value = value. (e.target = parentNode)
    #interpolations = ((binder) => new class {
        #items = [];
        #cleanup = () => { this.#items = this.#items.filter((x) => document.body.contains(x.obj)); };

        scan = () => {
            this.#cleanup();

            let counter = 0;

            const [rgx_l, rgx_r] = binder.#settings.interpolation.map(JSBinder.#escapeRgx);

            const rgx_interpolation = new RegExp(rgx_l + "(" + JSBinder.#RGX_EXP + ")" + rgx_r, "g");

            // "aa {{bb}} cc {{dd}} ee" >> "aa {0} cc {1} ee"
            const prepareString = (input) => input.replace(rgx_interpolation, (() => { let index = 0; return () => `{${index++}}`; })());

            // "{{aa}}" >> "aa"
            const trimExpression = (x) => x.replace(new RegExp("^" + rgx_l), "").replace(new RegExp(rgx_r + "$"), "").trim();

            const recurse = (element) => {
                if (element.nodeType === Node.TEXT_NODE) {
                    const m = element.textContent.match(rgx_interpolation);

                    if (m) {
                        this.#items.push({
                            obj: element,
                            type: "text",
                            expressions: [...m].map(trimExpression),
                            text: prepareString(element.textContent.trim()),
                            modified: new JSBinder.#ModifiedMemo(),
                        });
                        element.textContent = "";
                        counter++;
                    }
                }

                if (element.nodeType === Node.ELEMENT_NODE) {
                    const attributes = element.attributes;
                    for (let i = 0; i < attributes.length; i++) {
                        const m = attributes[i].value.match(rgx_interpolation);

                        if (m) {
                            if ((JSBinder.#typeOf(element) === JSBinder.#Type.SELECT || JSBinder.#typeOf(element) === JSBinder.#Type.INPUT) && attributes[i].name.toLowerCase() === "value")
                                JSBinder.#warn("Binding attribute 'value' on form elements can only be done with 'data-bind'.");

                            this.#items.push({
                                obj: element,
                                type: "attribute",
                                expressions: [...m].map(trimExpression),
                                key: attributes[i].name,
                                text: prepareString(attributes[i].value),
                                modified: new JSBinder.#ModifiedMemo(),
                            });
                            element.setAttribute(attributes[i].name, "");
                            counter++;
                        }
                    }
                }

                if (element.nodeType === Node.DOCUMENT_NODE || element.nodeType === Node.ELEMENT_NODE) binder.#findChildNodes(element)(x => recurse(x));
            };
            
            recurse(binder.#settings.root);

            return counter;
        };

        update = () => {
            this.#items.forEach((item) => {
                const result = item.expressions.reduce((text, expression, index) => text.replace("{"+index+"}", binder.#evaluate(expression)), item.text) ?? "";
                switch (item.type)
                {
                    case "text":
                        if (item.modified.check(result)) {
                            item.obj.textContent = result;
                            binder.#dispatchEvent(item.obj.parentNode, "bind", { value: result });
                        }
                        break;

                    case "attribute":
                        if (item.modified.check(result)) {
                            item.obj.setAttribute(item.key, result);
                            binder.#dispatchEvent(item.obj, "attr", { key: item.key, value: result });
                        }
                        break;
                }
            });
        };
    })(this);

    // data-bind='data.title'
    //
    // <div data-bind="..." /> >> <div>...</div>
    // <img data-bind="..." /> >> <img src="..." />
    // <input/select data-bind="..." /> >> <input/select value="..." />
    //
    // event: jsbinder-bind with e.detail.value = value.
    #bindDirective = ((binder) => new class {
        #items = [];
        #cleanup = () => { this.#items = this.#items.filter((x) => document.body.contains(x.obj)); };

        scan = () => {
            this.#cleanup();

            const $bind = binder.#mapAttributes("bind");

            const getDomDepth = (node) => Array.from(function* (n) { while (n.parentElement) yield (n = n.parentElement); }(node)).length;

            binder.#findDirectives($bind)
                ((obj) => {
                    const expression = JSBinder.#pop(obj)($bind);

                    this.#items.push({
                        obj, 
                        expressionTree: new JSBinder.#ExpressionTree(binder, expression),
                        modified: new JSBinder.#ModifiedMemo(), 
                        depth: getDomDepth(obj),
                    });
                });
        };

        update = () => {
            this.#items.sort((a, b) => b.depth - a.depth).forEach((item) => {
                const result = item.expressionTree.evaluate();
                switch (JSBinder.#typeOf(item.obj))
                {
                    case JSBinder.#Type.CHECKBOX:
                        if (item.modified.check(result)) {
                            item.obj.toggleAttribute("checked", !!result);
                            binder.#dispatchEvent(item.obj, "bind", { value: result });
                        }
                        break;

                    case JSBinder.#Type.SELECT:
                        if (item.modified.check(result) || item.obj.value !== (JSBinder.#isEmpty(result) ? "" : String(result))) {
                            item.obj.value = JSBinder.#isEmpty(result) ? "" : String(result);
                            binder.#dispatchEvent(item.obj, "bind", { value: result });
                        }
                        break;
                        
                    case JSBinder.#Type.INPUT:
                        if (item.modified.check(result)) {
                            item.obj.value = JSBinder.#isEmpty(result) ? "" : String(result);
                            binder.#dispatchEvent(item.obj, "bind", { value: result });
                        }
                        break;

                    case JSBinder.#Type.IMG:
                        if (item.modified.check(result)) {
                            item.obj.setAttribute("src", JSBinder.#isEmpty(result) ? null : result);
                            binder.#dispatchEvent(item.obj, "bind", { value: result });
                        }
                        break;

                    case JSBinder.#Type.IFRAME:
                        if (item.modified.check(result)) {
                            item.obj.contentWindow.location.replace(JSBinder.#isEmpty(result) ? null : result);
                            binder.#dispatchEvent(item.obj, "bind", { value: result });
                        }
                        break;

                    default:
                        if (item.modified.check(result)) {
                            item.obj.innerHTML = JSBinder.#isEmpty(result) ? "" : String(result);
                            binder.#dispatchEvent(item.obj, "bind", { value: result });
                        }
                        break;
                }
            });
        };
    })(this);

    // data-attr="'title' : data.title"
    // data-attr="'title' : data.title; 'src' : data.url"
    // data-disabled="valid !== true"
    //
    // event: jsbinder-attr with e.detail.key = attribute key and e.detail.value = value.
    #attributeDirective = ((binder) => new class {
        #items = [];
        #cleanup = () => { this.#items = this.#items.filter((x) => document.body.contains(x.obj)); };

        scan = () => {
            this.#cleanup();

            const [$attr, $disabled] = binder.#mapAttributes("attr", "disabled");

            binder.#findDirectives($attr)
                ((obj) => {
                    JSBinder.#split(JSBinder.#pop(obj)($attr)).forEach((mapping) => {
                        const m = mapping.match(new RegExp("^" + `(['"])` + `(${JSBinder.#RGX_ATTR})` + "\\1" + "\\s+" + ":" + "\\s+" + `(${JSBinder.#RGX_EXP})` + "$"));

                        if (!m)
                            return JSBinder.#error(`incorrect 'attribute' syntax: ${mapping}`);

                        const { 2: key, 3: expression } = m;

                        if ((JSBinder.#typeOf(obj) === JSBinder.#Type.SELECT || JSBinder.#typeOf(obj) === JSBinder.#Type.INPUT) && key.toLowerCase() === "value")
                            JSBinder.#warn("Binding attribute 'value' on form elements can only be done with 'data-bind'.");

                        this.#items.push({
                            obj, 
                            key, 
                            expressionTree: new JSBinder.#ExpressionTree(binder, expression),
                            modified: new JSBinder.#ModifiedMemo(),
                        });
                    });
                });

            binder.#findDirectives($disabled)
                ((obj) => {
                    const expression = JSBinder.#pop(obj)($disabled);

                    this.#items.push({
                        obj,
                        key: "disabled",
                        expressionTree: new JSBinder.#ExpressionTree(binder, "(" + expression + ") ? 'disabled' : null"),
                        modified: new JSBinder.#ModifiedMemo(),
                    });
                });
        };

        update = () => {
            this.#items.forEach((item) => {
                const result = item.expressionTree.evaluate();
                if (item.modified.check(result)) {
                    if (JSBinder.#isEmpty(result)) { item.obj.removeAttribute(item.key); } else { item.obj.setAttribute(item.key, result); };
                    binder.#dispatchEvent(item.obj, "attr", { key: item.key, value: result });
                }
            });
        };
    })(this);

    // data-class="'hidden' : data.visible == false"
    // data-class="'hidden' : data.visible == false; 'highlight" : data.important == true"
    // data-class="'disabled" : data.enabled !== true || data.expired === true"
    //
    // event: jsbinder-class with e.detail.key = class name.
    #classDirective = ((binder) => new class {
        #items = [];
        #cleanup = () => { this.#items = this.#items.filter((x) => document.body.contains(x.obj)); };

        scan = () => {
            this.#cleanup();

            const $class = binder.#mapAttributes("class");

            binder.#findDirectives($class)
                ((obj) => {
                    JSBinder.#split(JSBinder.#pop(obj)($class)).forEach((mapping) => {
                        const m = mapping.match(new RegExp("^" + `(['"])` + `(${JSBinder.#RGX_CLASS})` + "\\1" + "\\s+" + ":" + "\\s+" + `(${JSBinder.#RGX_EXP})` + "$"));

                        if (!m)
                            return JSBinder.#error(`incorrect 'class' syntax: ${mapping}`);

                        const { 2: key, 3: expression } = m;
                        this.#items.push({
                            obj, 
                            key, 
                            expressionTree: new JSBinder.#ExpressionTree(binder, expression), 
                            modified: new JSBinder.#ModifiedMemo(),
                        });
                    });
                });
        };

        update = () => {
            this.#items.forEach((item) => {
                const result = item.expressionTree.evaluate();
                if (item.modified.check(result)) {
                    item.obj.classList.toggle(item.key, result);
                    binder.#dispatchEvent(item.obj, "class", { key: item.key, action: result ? "add" : "remove" });
                }
            });
        };
    })(this);

    // data-style="'backgroundColor' : data.background"
    // data-style="'left' : data.x; 'top" : data.y"
    //
    // event: jsbinder-style with e.detail.key = css property.
    #styleDirective = ((binder) => new class {
        #items = [];
        #cleanup = () => { this.#items = this.#items.filter((x) => document.body.contains(x.obj)); };

        scan = () => {
            this.#cleanup();

            const $style = binder.#mapAttributes("style");

            binder.#findDirectives($style)
                ((obj) => {
                    JSBinder.#split(JSBinder.#pop(obj)($style)).forEach((mapping) => {
                        const m = mapping.match(new RegExp("^" + `(['"])` + `(${JSBinder.#RGX_ATTR})` + "\\1" + "\\s+" + ":" + "\\s+" + `(${JSBinder.#RGX_EXP})` + "$"));

                        if (!m)
                            return JSBinder.#error(`incorrect 'style' syntax: ${mapping}`);

                        const { 2: key, 3: expression } = m;
                        this.#items.push({
                            obj, 
                            key: JSBinder.#toKebabCase(key),
                            expressionTree: new JSBinder.#ExpressionTree(binder, expression), 
                            modified: new JSBinder.#ModifiedMemo(),
                        });
                    });
                });
        };

        update = () => {
            this.#items.forEach((item) => {
                const result = item.expressionTree.evaluate();
                if (item.modified.check(result)) {
                    if (JSBinder.#isEmpty(result)) { item.obj.style.removeProperty(item.key); } else { item.obj.style.setProperty(item.key, result); };
                    binder.#dispatchEvent(item.obj, "style", { key: item.key, value: result });
                }
            });
        };
    })(this);

    #addEvent = (obj) => (type, listener) => obj.addEventListener(type, listener, { 'signal': this.#abortController.signal });

    // <button data-onclick="page = 0">First page</button>
    // data-onclick="path1 = expression1; path2 = expression2"
    #onClickDirective = ((binder) => new class {
        scan = () => {
            const $onclick = binder.#mapAttributes("onclick");

            binder.#findDirectives($onclick)
                ((obj) => {
                    JSBinder.#split(JSBinder.#pop(obj)($onclick)).forEach((mapping) => {
                        const m = mapping.match(new RegExp("^" + `(${JSBinder.#RGX_PATH})` + "\\s+" + "=" + "\\s+" + `(${JSBinder.#RGX_EXP})` + "$"));

                        if (!m)
                            return JSBinder.#error(`incorrect 'onclick' syntax: ${mapping}`);

                        const { 1: target, 2: expression} = m;

                        const set = () => {
                            const evaluated = binder.#evaluate(expression);
                            binder.#set(target, evaluated);
                        };

                        binder.#addEvent(obj)("click", (e) => set());
                    });
                });
        };
    })(this);

    // <input type="text" data-onchange="name = @value" data-bind="name" />
    // data-onchange="path1 = expression1; path2 = expression2"
    #onChangeDirective = ((binder) => new class {
        scan = () => {
            const $onchange = binder.#mapAttributes("onchange");

            binder.#findDirectives($onchange)
                ((obj) => {
                    JSBinder.#split(JSBinder.#pop(obj)($onchange)).forEach((mapping) => {
                        const m = mapping.match(new RegExp("^" + `(${JSBinder.#RGX_PATH})` + "\\s+" + "=" + "\\s+" + `(${JSBinder.#RGX_EXP})` + "$"));

                        if (!m)
                            return JSBinder.#error(`incorrect 'onchange' syntax: ${mapping}`);

                        const { 1: target, 2: expression} = m;

                        const set = (value) => {
                            const evaluated = binder.#evaluate(expression.replace(JSBinder.#rgxFormatVariable("value"), value));
                            binder.#set(target, evaluated);
                        };

                        const toSafeString = (input) => "'" + input.replace(/\'/g, `' + "'" + '`) + "'";

                        //ToDo: textarea
                        switch (JSBinder.#typeOf(obj))
                        {
                            case JSBinder.#Type.CHECKBOX:
                                binder.#addEvent(obj)("change", (e) => set(!!obj.checked));
                                break;

                            case JSBinder.#Type.SELECT:
                                binder.#addEvent(obj)("change", (e) => set(toSafeString(obj.value)));
                                break;

                            case JSBinder.#Type.INPUT:
                                binder.#addEvent(obj)("input", (e) => set(toSafeString(obj.value)));
                                break;

                            default:
                                return JSBinder.#error(`'onchange' directive is only supported for <select> and <input>`);
                        }
                    });
                });
        };
    })(this);

    // { treeData: [
    //   { title: "Aaaa", items: [
    //     { title: "Bbbb", items: [...] }, 
    //     { title: "Cccc", items: [...] }
    //   ]}
    // ]}
    //
    // <template data-template="tree">
    //   <li data-each="@item in @data">
    //     <span>{{@item.title}}</span>
    //     <ul data-render="tree" data-source="@item.items"></ul>
    //   </li>
    // </template>
    // <ul data-render="tree" data-source="treeData"></ul>
    //
    // event: jsbinder-render.
    #templates = ((binder) => new class {
        #items = {};
        
        // Find all <template data-template='templatekey' /> to be used from elements with data-render='templatekey'.
        scan = () => {
            const $template = binder.#mapAttributes("template");

            binder.#findDirectives($template, "template")
                ((obj) => {
                    const key = JSBinder.#pop(obj)($template);
                    const html = JSBinder.#cleanHTML(obj.innerHTML);
                    
                    if (!key.match(new RegExp("^" + JSBinder.#RGX_VAR + "$")))
                        return JSBinder.#error(`template 'key' must match '${JSBinder.#RGX_VAR}'`);
                    
                    obj.remove();

                    if (this.#items[key] !== undefined)
                        JSBinder.#info(`a template with key '${key}' already exists and will be replaced.`);

                    this.#items = { ...this.#items, [key]: html };
                });
        };
        
        // Find elements with data-render='templatekey' and data-source='...' and replaces with html from <template data-template='templatekey'>...</template>
        // Template html variable '@data' will be replaced with source from 'data-source'.
        render = () => {
            let counter = 0;
            
            const [$render, $source] = binder.#mapAttributes("render", "source");
            
            binder.#findDirectives($render)
                ((obj) => {
                    const [key, source] = JSBinder.#pop(obj)($render, $source);
                    const template = this.#items[key];

                    if (!template)
                        return JSBinder.#error(`no template with key '${key}' found`);

                    if (!source)
                        return JSBinder.#error(`'render' must have 'source' defined`);

                    obj.innerHTML = template.replace(JSBinder.#rgxFormatVariable("data"), source);
                    binder.#dispatchEvent(obj, "render");
                    counter++;
                });
            
            return counter;
        };
    })(this);

    #scanRequest = false;
    #updateRequest = false;

    #lock = false;

    // let timed = new JSBinder.#Interval(() => { ... });
    // timed.start(1000); / timed.stop();
    static #Interval = class { #timer = null; #handler = () => {}; constructor (handler) { this.#handler = handler; }; start = (interval) => { this.#timer = window.setInterval(this.#handler, interval); }; stop = () => { window.clearInterval(this.#timer); }; };

    #highFrequencyController = new JSBinder.#Interval(() => {
        if (!this.#lock && this.#scanRequest)    { this.#scanRequest = false; this.#lock = true; this.#scan(); this.#lock = false; }
        if (!this.#lock && this.#updateRequest)  { this.#updateRequest = false; this.#lock = true; this.#update(); this.#lock = false; }
    });

    #lowFrequencyController = new JSBinder.#Interval(() => {
        if (this.#settings.root !== document && document.contains(this.#settings.root) === false) this.#dispose();
    });

    #scan = () => {
        [this.#templates, this.#ifDirective, this.#eachDirective, this.#forDirective, this.#interpolations, this.#bindDirective, this.#attributeDirective, this.#classDirective, this.#styleDirective, this.#onClickDirective, this.#onChangeDirective].forEach(x => x.scan());
        this.#update();
    };

    #update = () => {
        let count = 0;
        [this.#ifDirective, this.#eachDirective, this.#forDirective, this.#interpolations, this.#bindDirective, this.#attributeDirective, this.#classDirective, this.#styleDirective].forEach(x => count += x.update() ?? 0);
        if (count === 0) count += this.#templates.render();
        if (count > 0) this.#scan();
    };

    #dispose = () => {
        this.#highFrequencyController.stop();
        this.#lowFrequencyController.stop();
        this.#abortController.abort();
        this.#settings.root.removeAttribute("data-jsbinder");
        JSBinder.#info("Instance disposed!");
    };

    // myJSBinder.scan() : Scan the DOM for new elements to handle.
    scan = () => { this.#scanRequest = true; };

    // myJSBinder.dispose() : Dispose the instance and stop all events.
    // Remeber to set "myJSBinder = null;" to remove the reference to the instance (enabling garbage collection of the instance).
    dispose = () => { this.#dispose(); };
};