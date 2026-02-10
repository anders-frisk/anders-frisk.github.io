/**
 * @fileoverview JSBinder - Lightweight reactive data binding library
 * @version .
 * @author Anders Frisk
 * @license MIT
 * 
 * @description
 * JSBinder provides declarative data binding through HTML data attributes:
 * 
 * Directives:
 * - data-if: Conditional rendering
 * - data-each: List rendering with keys, where clauses, ordering
 * - data-for: Range-based iteration
 * - data-bind: Two-way data binding
 * - data-attr: Dynamic attributes
 * - data-class: Conditional CSS classes
 * - data-style: Dynamic inline styles
 * - data-onclick: Click event handlers with state mutations
 * - data-onchange: Change event handlers for form inputs
 * - data-template: Reusable templates
 * - data-render: Template rendering
 * 
 * Interpolation:
 * - {{expression}}: Evaluate expressions in text content or attributes
 * 
 * @see {@link https://github.com/anders-frisk/JSBinder}
 * 
 * (JSDoc generated with AI.)
 */


/**
 * JSBinder - A lightweight, reactive data binding library for vanilla JavaScript.
 * Provides two-way data binding, conditional rendering, list rendering, and more through HTML data attributes.
 * 
 * @class
 * @example
 * const binder = new JSBinder({ root: document.getElementById('app') });
 * binder.setState({ message: 'Hello World' });
 */
class JSBinder
{
    /**
     * Creates a new JSBinder instance and attaches it to a root element.
     * 
     * @param {Object} [options={}] - Configuration options for the JSBinder instance.
     * @param {HTMLElement} [options.root=document.body] - The root DOM element to bind to. All bindings will be scoped to this element and its descendants.
     * 
     * @example
     * // Bind to document.body (default)
     * const binder = new JSBinder();
     * 
     * @example
     * // Bind to specific element
     * const binder = new JSBinder({ root: document.querySelector('#app') });
     */
    constructor(options = {})
    {
        if (!JSBinder.#isPlainObject(options))
            throw new Error(JSBinder.#message(`'options' must be an object`));

        this.#settings = { root: document.body, ...options };
        
        if (!this.#settings.root)
            throw new Error(JSBinder.#message('Can not find the root element'));

        if (this.#settings.root.attributes.hasOwnProperty("data-jsbinder"))
            throw new Error(JSBinder.#message('An instance of JSBinder already exists on this root'));

        this.#settings.root.dataset.jsbinder = "";

        this.#abortController = new AbortController();
    };

    #abortController;
    #settings;

    static #message = (msg) => `JSBinder: ${msg}`;
    static #error = (msg) => console.error(JSBinder.#message(msg));
    static #info = (msg) => console.info(JSBinder.#message(msg));
    static #warn = (msg) => console.warn(JSBinder.#message(msg));

    static #unwrapSingleArray = (x) => (Array.isArray(x) && x.length === 1) ? x[0] : x;

    static #isPlainObject = (obj) => obj !== null && typeof obj === 'object' && !Array.isArray(obj);
    static #isNullish = (x) => [undefined, null, ""].includes(x);

    // Removes and returnes one or more dataset attributes from a DOM element as list or single.
    static #consumeDataset = (obj) => (...keys) => JSBinder.#unwrapSingleArray(keys.map(key => { const data = obj.dataset[key]?.trim().replace(/\s\s+/g, " ") ?? null; obj.removeAttribute(`data-${key}`); return data; }));
    static #split = (input) => input.split(";").map(x => x.trim()).filter(x => x !== ""); // Improvement: Do not split inside any strings. 

    // Clean HTML string from comments etc.
    static #cleanHTML = (html) => 
        html.trim()
            .replace(/<!--[\s\S]*?-->/g, "")
            .replace(/\s\s+/g, " ")
            .replace(/>\s+</g, "><");

    // Replaces a DOM element with one or more new elements, returning new elements as list or single.
    static #replaceObject = (obj) => (...objs) => { obj.replaceWith(...objs); return JSBinder.#unwrapSingleArray(objs); };

    // Create a DOM element from an HTML string.
    static #deserializeHTML = (html) => { let t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; };

    // Left-to-right function composition. JSBinder.#pipe(f1, f2, f3)(x) >> f3(f2(f1(x)));
    static #pipe = (...fns) => (x) => fns.reduce((v, f) => f(v), x);

    // JSBinder.#apply(args)(fn); Ex: JSBinder.#apply(getA(), getB(), ...)((a,b,...) => { /* ... */ });
    static #apply = (...x) => (f) => f(...x);

    // Get outermost bracket contents from string. Ex: JSBinder.#fromBrackets("aa[bb][cc[dd]]") >> ["bb", "cc[dd]"]
    static #fromBrackets = function* (str) { let start = -1, depth = 0; for (let i = 0; i < str.length; i++) { if (str[i] === '[') { if (depth === 0) start = i; depth++; } else if (str[i] === ']') { depth--; if (depth === 0 && start !== -1) { yield str.slice(start + 1, i); start = -1; } } } };

    // "months[m - 1]" >> ["m - 1"]
    static #getInnerExpressions = (str) =>
        JSBinder.#fromBrackets(str)
            .filter(x => !x.match(/^\{([a-zA-Z0-9_]+)\}$/)) // Skip full {index_key}
            .filter(x => !x.match(/^\d+$/)); // Skip full integers

    static #alphaNumericSorter = new class {
        #isNumeric = (val) => typeof val === 'number' || (!isNaN(val) && !isNaN(parseFloat(val)));
        sort = (a, b) => JSBinder.#apply(this.#isNumeric(a), this.#isNumeric(b))((aIsNum, bIsNum) => { if (aIsNum && !bIsNum) return 1; if (!aIsNum && bIsNum) return -1; if (aIsNum && bIsNum) return parseFloat(a) - parseFloat(b); return a.toString().localeCompare(b.toString(), undefined, { numeric: true, sensitivity: 'base' }); });
    };

    #indexMap = new Map();
    #state = {};
    #functions = {};

    /**
     * Updates the state object and triggers a refresh of all bindings.
     * Can accept either a plain object or a function that receives the current state and returns updates.
     * State updates are shallow-merged. Setting a property to `undefined` removes it from the state.
     * 
     * @param {Object|Function} data - The state updates to apply, or a function that receives current state and returns updates.
     * @returns {void}
     * 
     * @example
     * // Object update
     * binder.setState({ count: 5, message: 'Hello' });
     * 
     * @example
     * // Functional update
     * binder.setState((current) => ({ count: current.count + 1 }));
     * 
     * @example
     * // Remove a property by setting it to undefined
     * binder.setState({ temporaryData: undefined });
     * 
     * @example
     * // Add item to array
     * binder.setState((current) => ({ 
     *   items: [...current.items, { id: 4, name: 'New Item' }] 
     * }));
     */
    setState = (data) => {
        if (typeof data === "function" && data.length === 1) data = data(this.getState());

        if (!JSBinder.#isPlainObject(data))
            return JSBinder.#error(`'setState' requires an object or a function with a single attribute returning an object as input`);

        const recurse = (state, updates) => {
            Object.keys(updates).forEach((key) => { if (updates[key] === undefined) { delete state[key]; } else { state[key] = JSBinder.#isPlainObject(updates[key]) ? recurse(state[key] || {}, updates[key]) : updates[key]; } });
            return state;
        };

        this.#state = recurse(this.#state, data);
        this.#stateUpdated = true;
        this.#needsRefresh = true;
        this.#queueTasks();
    };

    /**
     * Returns a deep clone of the current state object.
     * The returned object is a copy and modifications to it will not affect the actual state.
     * 
     * @returns {Object} A deep clone of the current state.
     * 
     * @example
     * const currentState = binder.getState();
     * console.log(currentState.count); // 5
     * 
     * @example
     * // Safe to modify without affecting state
     * const state = binder.getState();
     * state.count = 999; // Does not change the actual state
     */
    getState = () => window.structuredClone(this.#state);
    
    /**
     * Registers a custom function that can be used in data binding expressions.
     * Functions are called with a single argument and prefixed with `#` in expressions.
     * 
     * @param {string} name - The function name (must be a valid JavaScript identifier without the # prefix).
     * @param {Function} method - A function that takes exactly one argument and returns a value.
     * @returns {void}
     * 
     * @example
     * // Register a rounding function
     * binder.addFunction('round', (x) => Math.round(x));
     * 
     * @example
     * // Use in HTML
     * // <span>{{#round(value)}}</span>
     * // If value = 5.7, displays: <span>6</span>
     */
    addFunction = (name, method) => {
        if (!name.match(/^[a-zA-Z]{1}[0-9a-zA-Z_]*$/))
            return JSBinder.#error(`'addFunction' parameter 'name' must be a correct variable name`);

        if (typeof method !== "function" || method.length !== 1)
            return JSBinder.#error(`'addFunction' 'method' must be a function with a single argument`);

        this.#functions = { ...this.#functions, ["#"+name]: method };
    };

    // Creates a path from expression. "data[0].title" >> ["data", 0, "title"]
    #createPath = (exp) => {
        const path = exp
            .replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => this.#indexMap.get(key)) // "{index_key}" >> index.
            .replace(/\[(\d+)\]/g, ".$1.") // array[1] >> array.1.
            .replace(/\.+/g, ".") // ".." >> "."
            .replace(/^\./g, "") // ".aa.bb" >> "aa.bb"
            .replace(/\.$/g, "") // "aa.bb." >> "aa.bb"
            .split(".");

        if (path.some(x => ["__proto__", "constructor", "prototype"].includes(x)))
            throw new Error(JSBinder.#message("Path includes forbidden keywords"));

        return path;
    };

    // Returns value from state, or returns evaluated if 'exp' is a base-object or string.
    #resolveValue = (exp) => {
        if (typeof exp !== "string") return exp; // true / false / null / undefined / numeric... etc.

        exp = exp.trim();

        if (exp.match(/^-?\d+$/)) return parseInt(exp); //int
        if (exp.match(/^-?\d+\.\d+$/)) return parseFloat(exp); //float
        if (exp.match(/^(['"]).*\1$/)) return exp.substr(1,exp.length-2); //string ('text' or "text")
        if (exp === "true") return true;
        if (exp === "false") return false;
        if (exp === "null") return null;
        if (exp === "undefined") return undefined;
        if (exp === "Infinity") return Infinity;
        if (exp === "NaN") return NaN;

        JSBinder.#getInnerExpressions(exp).forEach(x => JSBinder.#apply(this.#evaluate(x))((evaluated) => exp = exp.replace(`[${x}]`, `.${evaluated}.`)));

        return this.#createPath(exp).reduce((x, key) => (x === undefined || x[key] === undefined) ? undefined : x[key], this.#state);
    };

    // Mutates state by updating or removing a value
    #mutateState = (exp, value) => {
        const path = this.#createPath(exp.trim());
        const key = path.pop();

        const target = path.reduce((x, key) => (x === undefined || x[key] === undefined) ? undefined : x[key], this.#state);
        if (target) {
            target[key] = value;
            this.#stateUpdated = true;
            this.#needsRefresh = true;
            this.#queueTasks();
        }
    };

     // Expression solver - Parses and evaluates JavaScript-like expressions in bindings.
     // Handles operators, functions, ternary expressions, and respects operator precedence.
    static #Solver = class {
        static #OPERATORS = new Set(["?", ":", "(", ")", "!!", "!", "~", "<<", ">>", ">>>", "**", "*", "/", "%", "+", "-", ">=", ">", "<=", "<", "===", "==", "!==", "!=", "&", "^", "|", "&&", "||", "??"]);

        static #isFunction = (x) => typeof x === "string" && !!x.match(/^#[a-zA-Z]{1}[0-9a-zA-Z_]*$/);
        static #isOperator = (x) => typeof x === "string" && JSBinder.#Solver.#OPERATORS.has(x);

        // Tokenizer - Handles string parsing and token extraction.
        static #Tokenizer = class {
            #stringMap = new Map();
            #expressionMap = new Map();

            // Extract strings and temporary replace with placeholder.
            // "..." & '...' >> "{{str#index#}}"
            extractStrings = (exp) => {
                [...String(exp).matchAll(/'[^']*'|"[^"]*"/g)].forEach(([text], index) => {
                    this.#stringMap.set(index, text);
                    exp = exp.replace(text, `{{str${index}}}`);
                });
                return exp;
            };

            // Extract inner expressions and temporary replace with placeholder.
            // "[...]" >> "[{{exp#index#}}]"
            extractExpressions = (exp) => {
                JSBinder.#getInnerExpressions(exp).forEach((match, index) => {
                    this.#expressionMap.set(index, match);
                    exp = exp.replace(`[${match}]`, `[{{exp${index}}}]`);
                });
                return exp;
            };

            // Restore inner expressions.
            // "[{{exp#index#}}]" >> "[...]"
            restoreExpressions = (parts) => {
                parts = parts.map((x) => x.replace(/\{\{exp(\d+)\}\}/g, (_, index) => this.#expressionMap.get(parseInt(index))));
                return parts;
            };

            // Restore strings.
            // "{{str#index#}}" >> "..." & '...'
            restoreStrings = (parts) => {
                parts = parts.map((x) => {
                    const m = x.match(/^\{\{str(\d+)\}\}$/);
                    if (m) return this.#stringMap.get(parseInt(m[1])); // lägg till " ?? 'undefined_temp_value'" etc..?
                    return x;
                });
                return parts;
            };
        };

        // TreeBuilder - Constructs the AST from tokens.
        static #TreeBuilder = class {
            #parts;
            #pos = 0;

            constructor(parts)
            {
                this.#parts = parts;
            }

            build = () => this.#parseExpression();

            #parseExpression = () => {
                let output = [];

                // ["(", "1", "+", "1", ")", "/", "2"] >> [["1", "+", "1"], "/", "2"]
                while (this.#pos < this.#parts.length) {
                    if (this.#parts[this.#pos] === "(") { this.#pos++; output.push(JSBinder.#unwrapSingleArray(this.#parseExpression())); }
                    else if (this.#parts[this.#pos] === ")") { this.#pos++; break; }
                    else { output.push(this.#parts[this.#pos]); this.#pos++ }
                }

                // (right to left) (..., operator) "-", "5", ... >> (..., operator) ["-", "5"], ...
                for (let x = output.length - 2; x >= 0; x--)
                    if (["-", "+"].includes(output[x]) && (x === 0 || JSBinder.#Solver.#isOperator(output[x-1])))
                        output.splice(x, 2, [output[x], output[x+1]]);

                // (right to left) ..., prefix_operator, operand, ... >> ..., [prefix_operator, operand], ...
                // ["false", "===", "!", "true"] >> ["false", "===", ["!", "true"]]
                // ["false", "===", "!", "!", "true"] >> ["false", "===", ["!", ["!", "true"]]]
                for (let x = output.length - 2; x >= 0; x--)
                    if (["!!", "!", "~"].includes(output[x]))
                        output.splice(x, 2, [output[x], output[x+1]]);
        
                // (right to left) ..., operand, infix_operator, operand, ... >> ..., [operand, infix_operator, operand], ...
                for (let x = output.length - 3; x >= 0; x--)
                    if (["**"].includes(output[x+1]))
                        output.splice(x, 3, [output[x], output[x+1], output[x+2]]);

                // (left to right) ..., operand, infix_operator, operand, ... >> ..., [operand, infix_operator, operand], ...
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
        };

        // TreeEvaluator - Evaluates the constructed AST.
        static #Evaluator = class {
            #binder;

            constructor(binder)
            {
                this.#binder = binder;
            }

            evaluate = (tree) => this.#evaluate(tree);

            // Evaluates prefix (unary) expressions. Ex: '!true' (operator operand)
            // map: [['!', (a) => !a], ...] data: ['!', true] >> [false]
            static #evaluatePrefixOperations = (data, map) => {
                map.forEach(([op, func]) => { if (data.length === 2 && data[0] === op) { data = [func(data[1])]; } });
                return data;
            };

            // Evaluates infix (binary) expressions. Ex: '1+2' (operand operator operand)
            // map: [['+', (a, b) => a+b], ...] data: [1, '+', 2] >> [3]
            static #evaluateInfixOperations = (data, map) => {
                map.forEach(([op, func]) => { if (data.length === 3 && data[1] === op) { data = [func(data[0], data[2])]; } });
                return data;
            };

            static #prefixOperations =
            [
                ["!!", (x) => !!x],
                ["!",  (x) =>  !x],
                ["~",  (x) =>  ~x],
                ["-",  (x) => 0-x],
                ["+",  (x) => 0+x],
            ];

            static #infixOperations =
            [
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
            ];

            #evaluate = (tree) => {
                // [[1, "==", 2], "?", "'yes'", ":", "'no'" ] >> ["'no'"]
                const handleTernary = (data) => {
                    const list = (x) => Array.isArray(x) ? x : [x];

                    if (data.length === 5 && data[1] === "?" && data[3] === ":") data = evaluateTree(list(data[0])) ? list(data[2]) : list(data[4]);
                    return data;
                };

                // [#round, 5.5] >> [6]
                const handleFunctions = (data) =>
                    JSBinder.#Solver.#Evaluator.#evaluatePrefixOperations(data, Object.entries(this.#binder.#functions)); //Object.entries(...) >> [["#round", (x) => Math.round(x)], ...]

                // ["!", true] >> [false]
                const handlePrefixOperations = (data) => 
                    JSBinder.#Solver.#Evaluator.#evaluatePrefixOperations(data, JSBinder.#Solver.#Evaluator.#prefixOperations);

                // [1, "+", 2] >> [3]
                const handleInfixOperations = (data) =>
                    JSBinder.#Solver.#Evaluator.#evaluateInfixOperations(data, JSBinder.#Solver.#Evaluator.#infixOperations);

                // Recursive parse tree nodes to values.
                // ["'string'", "vaiable_eq_1", "true", ...] >> ["string", 1, true, ...]
                const resolveLiterals = (input) => input
                    .map((x) => Array.isArray(x) ? resolveLiterals(x) : x)
                    .map((x) => !Array.isArray(x) && !JSBinder.#Solver.#isFunction(x) && !JSBinder.#Solver.#isOperator(x) ? this.#binder.#resolveValue(x) : x);

                // Recursive solve tree.
                const evaluateTree = (input) => JSBinder.#pipe(handleTernary, handleFunctions, handlePrefixOperations, handleInfixOperations, JSBinder.#unwrapSingleArray)(input.map((x) => Array.isArray(x) ? evaluateTree(x) : x));

                return JSBinder.#pipe(resolveLiterals, evaluateTree)(tree);
            };
        };

        // Main ExpressionTree class - Coordinates the parsing and evaluation.
        static ExpressionTree = class {
            #tree;
            #evaluator;

            constructor (binder, exp)
            {
                this.#tree = this.#buildTree(exp);
                this.#evaluator = new JSBinder.#Solver.#Evaluator(binder);
            };

            #buildTree = (exp) => {
                const tokenizer = new JSBinder.#Solver.#Tokenizer();

                exp = tokenizer.extractStrings(exp);
                exp = tokenizer.extractExpressions(exp);

                // Split expression
                // "5+3-x" >> "5 + 3 - x" >> ["5", "+", "3", "-", "x"]
                let parts = exp
                    .replace(/(>>>|===|!==|!!|<<|>>|\*\*|>=|<=|==|!=|&&|\|\||\?\?|\?|:|\(|\)|!|~|\*|\/|%|\+|-|>|<|&|\^|\|)/g, " $1 ")
                    .trim()
                    .split(/\s+/);

                parts = tokenizer.restoreExpressions(parts);
                parts = tokenizer.restoreStrings(parts);

                return new JSBinder.#Solver.#TreeBuilder(parts).build();
            };

            // Recursive evaluation of expression tree.
            evaluate = () => this.#evaluator.evaluate(this.#tree);
        };
    };

    #evaluate = (expression) => (new JSBinder.#Solver.ExpressionTree(this, expression)).evaluate();


    static #TYPE = { CHECKBOX: "checkbox", INPUT: "input", SELECT: "select", IMG: "img", IFRAME: "iframe", TEXTAREA: "textarea" };

    static #typeOf = (obj) => {
        if (obj.matches("input[type='checkbox']")) return JSBinder.#TYPE.CHECKBOX;
        if (obj.matches("input")) return JSBinder.#TYPE.INPUT;
        if (obj.matches("select")) return JSBinder.#TYPE.SELECT;
        if (obj.matches("img")) return JSBinder.#TYPE.IMG;
        if (obj.matches("iframe")) return JSBinder.#TYPE.IFRAME;
        if (obj.matches("textarea")) return JSBinder.#TYPE.TEXTAREA;
        return null;
    };

    static #rgxFormatVariable = (key) => new RegExp(`@${key}\\b`, "g");

    // Helper function to find directives in the DOM not inside a template or other directive.
    #queryDirectives = (selector) => (callback) => {
        [...this.#settings.root.querySelectorAll(selector)]
            .filter((obj) => !["[data-if]", "[data-each]", "[data-for]", "template"].some(x => !!obj.parentNode.closest(x)))
            .filter((obj) => obj.closest("[data-jsbinder]") === this.#settings.root)
            .forEach((obj) => callback(obj));
    };

    // Helper function to find childNodes of parent not inside a template or other directive.
    #iterateChildNodes = (parent) => (callback) => {
        [...parent.childNodes]
            .filter((obj) => obj.nodeType !== Node.ELEMENT_NODE || !["[data-if]", "[data-each]", "[data-for]", "template"].some(x => !!obj.matches(x)))
            .filter((obj) => obj.nodeType !== Node.ELEMENT_NODE || !obj.matches("[data-jsbinder]"))
            .forEach((obj) => callback(obj));
    };

    // Helper function to dispatch custom JSBinder events.
    static #dispatchEvent = (obj, type, detail = {}) => obj.dispatchEvent(new CustomEvent(`jsbinder-${type}`, { 'bubbles': true, 'detail': detail }));

    // Memoization of last value to check if it has changed.
    // let memo = new JSBinder.#ChangeDetector();
    // memo.check(data) >> boolean (true on first call or if data is different from last check.)
    static #ChangeDetector = class { #current = null; #first = true; check = (value) => { if (this.#first === true || value !== this.#current) { this.#current = value; this.#first = false; return true; } return false; } };

    // If
    //
    // data-if="data.visible === true"
    // data.visible = true  >> <div data-if="data.visible === true">...</div> >> <div>...</div>
    // data.visible = false >> <div data-if="data.visible === true">...</div> >> <!-- if -->
    //
    // event: jsbinder-if with e.detail.action = "add" / "remove".
    #ifDirective = ((binder) => new class {
        #bindings = [];
        #pruneDetached = () => { this.#bindings = this.#bindings.filter((x) => document.body.contains(x.obj)); };

        // Finds and stores data-if elements, replacing them with comment placeholders.
        register = () => {
            this.#pruneDetached();

            binder.#queryDirectives("[data-if]")
                ((obj) => {
                    const expression = JSBinder.#consumeDataset(obj)("if");
                    const html = JSBinder.#cleanHTML(obj.outerHTML);
                    const placeholder = JSBinder.#replaceObject(obj)(document.createComment("if"));

                    this.#bindings.push({
                        obj: placeholder, 
                        html, 
                        expressionTree: new JSBinder.#Solver.ExpressionTree(binder, expression), 
                        modified: new JSBinder.#ChangeDetector(),
                    });
                });
        };

        // Toggles visibility by swapping between stored HTML and comment placeholders based on expression results.
        refresh = () => {
            let counter = 0;

            this.#bindings.forEach((binding) => {
                const result = !!binding.expressionTree.evaluate();
                if (binding.modified.check(result)) {
                    if (result === true) {
                        binding.obj = JSBinder.#replaceObject(binding.obj)(JSBinder.#deserializeHTML(binding.html));
                        JSBinder.#dispatchEvent(binding.obj, "if", { action: "add" });
                        counter++;
                    } else {
                        JSBinder.#dispatchEvent(binding.obj, "if", { action: "remove" });
                        binding.obj = JSBinder.#replaceObject(binding.obj)(document.createComment("if"));
                    }
                }
            });

            return counter;
        };
    })(this);

    // Each
    //
    // data-each="@item in items" data-key="@item..." [data-where="..."] [data-skip="..."] [data-limit="..."] [data-orderby="..."] [data-distinct="..."]
    //
    // { items: ["a", "b", ...] }      >> <p data-each="@item in items" data-key="@item">{{@item}}</p>                                        >> <p>a</p><p>b</p>...
    // { items: [{title: "a"}, ...] }  >> <p data-each="@item in items" data-key="@item.title">{{@item.title}}</p>                            >> <p>a</p>...
    // { numbers: [1,2,3,4,5, ...] }   >> <p data-each="@number in numbers" data-key="@number" data-where="@number > 3">{{@number}}</p>       >> <p>4</p><p>5</p>...
    // { numbers: [1,2,3,4,5, ...] }   >> <p data-each="@number in numbers" data-key="@number" data-skip="1" data-limit="2">{{@number}}</p>   >> <p>2</p><p>3</p>
    //
    // event: jsbinder-each with e.detail.action = "add" / "remove".
    #eachDirective = ((binder) => new class {
        #bindings = [];
        #pruneDetached = () => { this.#bindings = this.#bindings.filter((x) => document.body.contains(x.start)); };
        #index = 0;

        #RGX_EACH_DIRECTIVE = /^@([a-zA-Z]{1}[0-9a-zA-Z_]*)\s+in\s+([a-zA-Z]{1}[0-9a-zA-Z_]*(?:(?:\[.+\]|\.)(?:[a-zA-Z]{1}[0-9a-zA-Z_]*)?)*)$/;

        // Scans for data-each elements, extracts configuration, and stores template HTML with comment markers.
        register = () => {
            this.#pruneDetached();

            binder.#queryDirectives("[data-each]")
                ((obj) => {
                    const [expression, key, where, skip, limit, orderby, distinct] = JSBinder.#consumeDataset(obj)("each", "key", "where", "skip", "limit", "orderby", "distinct");
                    const html = JSBinder.#cleanHTML(obj.outerHTML);
                    const [start, end] = JSBinder.#replaceObject(obj)(document.createComment("each"), document.createComment("/each"));

                    if (key === null)
                        return JSBinder.#error("'each' must have 'key' expression defined");

                    const m = expression.match(this.#RGX_EACH_DIRECTIVE);

                    if (!m)
                        return JSBinder.#error(`Incorrect 'each' expression: ${expression}`);

                    const { 1: alias, 2: list } = m;
                    this.#bindings.push({
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
                        limitTree: limit !== null ? new JSBinder.#Solver.ExpressionTree(binder, limit) : null,
                        skipTree: skip !== null ? new JSBinder.#Solver.ExpressionTree(binder, skip) : null,
                    });
                });
        };

        // Evaluates list expressions, filters/sorts items, and updates DOM by adding/removing/reordering elements.
        refresh = () => {
            let counter = 0;

            this.#bindings.forEach((binding) => {
                const whereNotIn = (other) => (x) => !other.includes(x);
                const whereNotNull = (x) => x !== null;

                const skip = binding.skipTree !== null ? binding.skipTree.evaluate() : null;
                const limit = binding.limitTree !== null ? binding.limitTree.evaluate() : null;

                const RGX_VARIABLE_ALIAS = JSBinder.#rgxFormatVariable(binding.alias);

                // Create list of all indexes to include, filtered by 'where' if defined.
                let indexes = JSBinder.#apply(binder.#resolveValue(binding.list))
                    ((source) => Array.isArray(source)
                        ? [...function* () { for (var i = 0; i < source.length; i++) { if (binding.where === null || binder.#evaluate(binding.where.replace(RGX_VARIABLE_ALIAS, `${binding.list}[${i}]`))) yield(i); }; }()]
                        : []);

                // Sort list of indexes if 'orderby' is defined.
                if (binding.orderby !== null) {
                    indexes = indexes
                        .map(index => ({ index, value : binder.#evaluate(binding.orderby.replace(RGX_VARIABLE_ALIAS, `${binding.list}[${index}]`)) }))
                        .sort((a, b) => JSBinder.#alphaNumericSorter.sort(a.value, b.value))
                        .map(x => x.index);
                }

                // Filter on distinct values if 'distinct' is defined.
                if (binding.distinct !== null) {
                    const distinctIndexes = Array.from(new Map(indexes.toReversed().map((index) => [binder.#evaluate(binding.distinct.replace(RGX_VARIABLE_ALIAS, `${binding.list}[${index}]`)), index])).values());
                    indexes = indexes.filter((index) => distinctIndexes.includes(index));
                }

                // Reduce list of indexes if 'skip' or 'limit' is defined.
                if (skip !== null) indexes = indexes.slice(skip);
                if (limit !== null) indexes = indexes.slice(0, limit);

                // Calculate keys for each index.
                const newKeys = indexes.map((index) => 
                    JSBinder.#apply(binder.#evaluate(binding.key.replace(RGX_VARIABLE_ALIAS, `${binding.list}[${index}]`)).toString().replace(/[^a-zA-Z0-9]/g, "_"))
                        ((key) => {
                            binder.#indexMap.set(`${binding.itemIndex}_${key}`, index);
                            return `${binding.itemIndex}_${key}`;
                        }));

                // Compare keys to know what to add or remove.
                const keysToRemove = binding.keys.filter(whereNotIn(newKeys));
                const keysToAdd = newKeys.filter(whereNotIn(binding.keys));

                // Remove existing items.
                binding.keys.forEach((key, i) => {
                    if (keysToRemove.includes(key)) {
                        JSBinder.#dispatchEvent(binding.objs[i], "each", { action: "remove" });
                        binding.objs[i].remove();
                        binding.objs[i] = null;
                        binding.keys[i] = null;
                    }
                });

                // Filtered lists to not include removed elements.
                let existingKeys = binding.keys.filter(whereNotNull);
                let existingObjs = binding.objs.filter(whereNotNull);

                let lastObj = binding.start; //Store reference to element to add new items after.
                let newObjs = [];

                newKeys.forEach((key) => {
                    let obj = null;

                    if (keysToAdd.includes(key)) {
                        // Add new item.
                        obj = JSBinder.#deserializeHTML(binding.html.replace(RGX_VARIABLE_ALIAS, `${binding.list}[{${key}}]`));
                        lastObj.after(obj);
                        JSBinder.#dispatchEvent(obj, "each", { action: "add" });
                        counter++;
                    } else {
                        // Reorder existing items if needed.
                        const index = existingKeys.indexOf(key);
                        obj = existingObjs[index];

                        if (index > 0) lastObj.after(obj); // If object is not next of existing it needs to be moved to after "lastObj".

                        existingObjs.splice(index, 1); // Removes object from list of old objects (unhandled objects).
                        existingKeys.splice(index, 1);
                    }

                    lastObj = obj;
                    newObjs.push(obj);
                });

                binding.objs = newObjs;
                binding.keys = newKeys;
            });

            return counter;
        };
    })(this);

    // For
    //
    // data-for="@value" data-from="..." data-to="..." [data-where="..."]
    //
    // <p data-for="@index" data-from="0" data-to="myArray.length">{{myArray[@index]}}</p>              >> ...
    // <p data-for="@number" data-from="3" data-to="7">{{@number}}</p>                                  >> <p>3</p><p>4</p>...<p>7</p>
    // <p data-for="@number" data-from="1" data-to="7" data-where="@number % 2 === 0">{{@number}}</p>   >> <p>2</p><p>4</p><p>6</p>
    //
    // event: jsbinder-for with e.detail.action = "add" / "remove".
    #forDirective = ((binder) => new class {
        #bindings = [];
        #pruneDetached = () => { this.#bindings = this.#bindings.filter((x) => document.body.contains(x.start)); };

        #RGX_FOR_DIRECTIVE = /^@([a-zA-Z]{1}[0-9a-zA-Z_]*)$/;

        // Finds data-for elements with range specifications and stores template HTML with comment markers.
        register = () => {
            this.#pruneDetached();

            binder.#queryDirectives("[data-for]")
                ((obj) => {
                    const [expression, from, to, where] = JSBinder.#consumeDataset(obj)("for", "from", "to", "where");
                    const html = JSBinder.#cleanHTML(obj.outerHTML);
                    const [start, end] = JSBinder.#replaceObject(obj)(document.createComment("for"), document.createComment("/for"));

                    if (from === null || to === null)
                        return JSBinder.#error("'for' must have 'from' and 'to' expressions defined");

                    const m = expression.match(this.#RGX_FOR_DIRECTIVE);

                    if (!m)
                        return JSBinder.#error(`Incorrect 'for' expression: ${expression}`);

                    const { 1: alias } = m;
                    this.#bindings.push({
                        html, 
                        keys: [], 
                        objs: [], 
                        start, 
                        end, 
                        alias, 
                        where,
                        fromTree: new JSBinder.#Solver.ExpressionTree(binder, from), 
                        toTree: new JSBinder.#Solver.ExpressionTree(binder, to),
                    });
                });
        };

        // Generates numeric ranges, filters by where clause, and updates DOM with matching elements.
        refresh = () => {
            let counter = 0;

            this.#bindings.forEach((binding) => {
                const whereNotIn = (other) => (x) => !other.includes(x);
                const whereNotNull = (x) => x !== null;

                const from = binding.fromTree.evaluate();
                const to = binding.toTree.evaluate();

                const RGX_VARIABLE_ALIAS = JSBinder.#rgxFormatVariable(binding.alias);

                // Create list of all keys/numbers to include, filtered by 'where' if defined.
                const newKeys = [...function* () { for (let key = from; key <= to; key++) { if (binding.where === null || binder.#evaluate(binding.where.replace(RGX_VARIABLE_ALIAS, key))) yield(key); } }()];

                // Compare keys to know what to add or remove.
                const keysToRemove = binding.keys.filter(whereNotIn(newKeys));
                const keysToAdd = newKeys.filter(whereNotIn(binding.keys));

                // Remove existing items
                binding.keys.forEach((key, i) => {
                    if (keysToRemove.includes(key)) {
                        JSBinder.#dispatchEvent(binding.objs[i], "for", { action: "remove" });
                        binding.objs[i].remove();
                        binding.objs[i] = null;
                        binding.keys[i] = null;
                    }
                });

                // Filtered lists to not include removed elements
                let existingKeys = binding.keys.filter(whereNotNull);
                let existingObjs = binding.objs.filter(whereNotNull);

                let lastObj = binding.start; // Store reference to element to add new items after...
                let newObjs = [];

                newKeys.forEach((key) => {
                    let obj = null;

                    if (keysToAdd.includes(key)) {
                        // Add new item
                        obj = JSBinder.#deserializeHTML(binding.html.replace(RGX_VARIABLE_ALIAS, key));
                        lastObj.after(obj);
                        JSBinder.#dispatchEvent(obj, "for", { action: "add" });
                        counter++;
                    } else {
                        // Existing items...
                        const index = existingKeys.indexOf(key);
                        obj = existingObjs[index];
                    }
                    
                    lastObj = obj;
                    newObjs.push(obj);
                });

                binding.objs = newObjs;
                binding.keys = newKeys;
            });

            return counter;
        };
    })(this);

    // Interpolations
    //
    // <div>{{details.title}}</div>
    // <a href="{{link.url}}">{{link.title}}</a>
    // <div>{{cart.length}} {{cart.length === 1 ? "item" : "items"}} in cart.</div>
    //
    // event: jsbinder-attr with e.detail.key = attribute key and e.detail.value = value.
    //        jsbinder-bind with e.detail.value = value. (e.target = parentNode)
    #interpolationDirective = ((binder) => new class {
        #bindings = [];
        #pruneDetached = () => { this.#bindings = this.#bindings.filter((x) => document.body.contains(x.obj)); };

        #RGX_INTERPOLATION_DIRECTIVE = /\{\{(.+)\}\}/g;

        // Scans text content and attributes for {{...}} expressions, extracting and storing them.
        register = () => {
            this.#pruneDetached();

            let counter = 0;

            // "aa {{bb}} cc {{dd}} ee" >> "aa {0} cc {1} ee"
            const prepareString = (input) => input.replace(this.#RGX_INTERPOLATION_DIRECTIVE, (() => { let index = 0; return () => `{${index++}}`; })());

            // "{{aa}}" >> "aa"
            const trimExpression = (x) => x.replace(/^\{\{/, "").replace(/\}\}$/, "").trim();

            const scanNode = (element) => {

                // Find all interolations in innerHTML.
                // Ex: <h1>{{page.title}}</h1>
                if (element.nodeType === Node.TEXT_NODE) {
                    const m = element.textContent.match(this.#RGX_INTERPOLATION_DIRECTIVE);

                    if (m) {
                        this.#bindings.push({
                            obj: element,
                            type: "text",
                            expressions: [...m].map(trimExpression),
                            text: prepareString(element.textContent.trim()),
                            modified: new JSBinder.#ChangeDetector(),
                        });
                        element.textContent = "";
                        counter++;
                    }
                }

                // Find all interpolations in attributes.
                // Ex: <img alt="{{image.description}}" />
                if (element.nodeType === Node.ELEMENT_NODE) {
                    const attributes = element.attributes;
                    for (let i = 0; i < attributes.length; i++) {
                        const m = attributes[i].value.match(this.#RGX_INTERPOLATION_DIRECTIVE);

                        if (m) {
                            if ((JSBinder.#typeOf(element) === JSBinder.#TYPE.SELECT || JSBinder.#typeOf(element) === JSBinder.#TYPE.INPUT) && attributes[i].name.toLowerCase() === "value")
                                JSBinder.#warn("Binding attribute 'value' on form elements can only be done with 'data-bind'.");

                            this.#bindings.push({
                                obj: element,
                                type: "attribute",
                                expressions: [...m].map(trimExpression),
                                key: attributes[i].name,
                                text: prepareString(attributes[i].value),
                                modified: new JSBinder.#ChangeDetector(),
                            });
                            element.setAttribute(attributes[i].name, "");
                            counter++;
                        }
                    }
                }

                // Recurse for child elements.
                if (element.nodeType === Node.DOCUMENT_NODE || element.nodeType === Node.ELEMENT_NODE) binder.#iterateChildNodes(element)(x => scanNode(x));
            };
            
            scanNode(binder.#settings.root);

            return counter;
        };

        // Evaluates interpolation expressions and updates text content or attribute values.
        refresh = () => {
            this.#bindings.forEach((binding) => {
                const result = binding.expressions.reduce((text, expression, index) => text.replace("{"+index+"}", binder.#evaluate(expression)), binding.text) ?? "";
                switch (binding.type)
                {
                    case "text":
                        if (binding.modified.check(result)) {
                            binding.obj.textContent = result;
                            JSBinder.#dispatchEvent(binding.obj.parentNode, "bind", { value: result });
                        }
                        break;

                    case "attribute":
                        if (binding.modified.check(result)) {
                            binding.obj.setAttribute(binding.key, result);
                            JSBinder.#dispatchEvent(binding.obj, "attr", { key: binding.key, value: result });
                        }
                        break;
                }
            });
        };
    })(this);

    // Bind
    //
    // data-bind='data.title'
    //
    // <div data-bind="..." /> >> <div>...</div>
    // <img data-bind="..." /> >> <img src="..." />
    // <input/select data-bind="..." /> >> <input/select value="..." />
    //
    // event: jsbinder-bind with e.detail.value = value.
    #bindDirective = ((binder) => new class {
        #bindings = [];
        #pruneDetached = () => { this.#bindings = this.#bindings.filter((x) => document.body.contains(x.obj)); };

        #getDomDepth = (node) => Array.from(function* (n) { while (n.parentElement) yield (n = n.parentElement); }(node)).length;

        // Finds data-bind elements and stores their expressions with DOM depth for proper evaluation order.
        register = () => {
            this.#pruneDetached();

            binder.#queryDirectives("[data-bind]")
                ((obj) => {
                    const expression = JSBinder.#consumeDataset(obj)("bind");

                    this.#bindings.push({
                        obj, 
                        expressionTree: new JSBinder.#Solver.ExpressionTree(binder, expression),
                        modified: new JSBinder.#ChangeDetector(), 
                        depth: this.#getDomDepth(obj),
                    });
                });
        };

        // Evaluates expressions and updates element content/values/attributes based on element type.
        refresh = () => {
            this.#bindings.sort((a, b) => b.depth - a.depth).forEach((binding) => {
                const result = binding.expressionTree.evaluate();
                switch (JSBinder.#typeOf(binding.obj))
                {
                    case JSBinder.#TYPE.CHECKBOX:
                        if (binding.modified.check(result)) {
                            binding.obj.toggleAttribute("checked", !!result);
                            JSBinder.#dispatchEvent(binding.obj, "bind", { value: result });
                        }
                        break;

                    case JSBinder.#TYPE.SELECT:
                        if (binding.modified.check(result) || binding.obj.value !== (JSBinder.#isNullish(result) ? "" : String(result))) {
                            binding.obj.value = JSBinder.#isNullish(result) ? "" : String(result);
                            JSBinder.#dispatchEvent(binding.obj, "bind", { value: result });
                        }
                        break;
                        
                    case JSBinder.#TYPE.INPUT:
                        if (binding.modified.check(result)) {
                            binding.obj.value = JSBinder.#isNullish(result) ? "" : String(result);
                            JSBinder.#dispatchEvent(binding.obj, "bind", { value: result });
                        }
                        break;

                    case JSBinder.#TYPE.IMG:
                        if (binding.modified.check(result)) {
                            binding.obj.setAttribute("src", JSBinder.#isNullish(result) ? null : result);
                            JSBinder.#dispatchEvent(binding.obj, "bind", { value: result });
                        }
                        break;

                    case JSBinder.#TYPE.IFRAME:
                        if (binding.modified.check(result)) {
                            binding.obj.contentWindow.location.replace(JSBinder.#isNullish(result) ? null : result);
                            JSBinder.#dispatchEvent(binding.obj, "bind", { value: result });
                        }
                        break;

                    default:
                        if (binding.modified.check(result)) {
                            binding.obj.innerHTML = JSBinder.#isNullish(result) ? "" : String(result);
                            JSBinder.#dispatchEvent(binding.obj, "bind", { value: result });
                        }
                        break;
                }
            });
        };
    })(this);

    // Attribute
    //
    // data-attr="'title' : data.title"
    // data-attr="'title' : data.title; 'src' : data.url"
    // data-disabled="valid !== true"
    //
    // event: jsbinder-attr with e.detail.key = attribute key and e.detail.value = value.
    #attributeDirective = ((binder) => new class {
        #bindings = [];
        #pruneDetached = () => { this.#bindings = this.#bindings.filter((x) => document.body.contains(x.obj)); };

        #RGX_ATTRIBUTE_DIRECTIVE = /^(['"])([a-zA-Z]{1}[0-9a-zA-Z_-]*)\1\s+:\s+(.+)$/;

        // Scans for data-attr directives, parsing attribute:expression mappings.
        register = () => {
            this.#pruneDetached();

            binder.#queryDirectives("[data-attr]")
                ((obj) => {
                    JSBinder.#split(JSBinder.#consumeDataset(obj)("attr")).forEach((mapping) => {
                        const m = mapping.match(this.#RGX_ATTRIBUTE_DIRECTIVE);

                        if (!m)
                            return JSBinder.#error(`Incorrect 'attribute' syntax: ${mapping}`);

                        const { 2: key, 3: expression } = m;

                        if ((JSBinder.#typeOf(obj) === JSBinder.#TYPE.SELECT || JSBinder.#typeOf(obj) === JSBinder.#TYPE.INPUT) && key.toLowerCase() === "value")
                            JSBinder.#warn("Binding attribute 'value' on form elements can only be done with 'data-bind'.");

                        this.#bindings.push({
                            obj, 
                            key, 
                            expressionTree: new JSBinder.#Solver.ExpressionTree(binder, expression),
                            modified: new JSBinder.#ChangeDetector(),
                        });
                    });
                });

            // Custom [data-disabled] implementation of [data-attr], to enable/disable form elements.
            binder.#queryDirectives("[data-disabled]")
                ((obj) => {
                    const expression = JSBinder.#consumeDataset(obj)("disabled");

                    this.#bindings.push({
                        obj,
                        key: "disabled",
                        expressionTree: new JSBinder.#Solver.ExpressionTree(binder, "(" + expression + ") ? 'disabled' : null"),
                        modified: new JSBinder.#ChangeDetector(),
                    });
                });
        };

        // Evaluates expressions and sets/removes attributes based on results.
        refresh = () => {
            this.#bindings.forEach((binding) => {
                const result = binding.expressionTree.evaluate();
                if (binding.modified.check(result)) {
                    if (JSBinder.#isNullish(result)) { binding.obj.removeAttribute(binding.key); } else { binding.obj.setAttribute(binding.key, result); };
                    JSBinder.#dispatchEvent(binding.obj, "attr", { key: binding.key, value: result });
                }
            });
        };
    })(this);

    // Class
    //
    // data-class="'hidden' : data.visible === false"
    // data-class="'hidden' : data.visible === false; 'highlight" : data.important === true"
    // data-class="'disabled" : data.enabled !== true || data.expired === true"
    //
    // event: jsbinder-class with e.detail.key = class name.
    #classDirective = ((binder) => new class {
        #bindings = [];
        #pruneDetached = () => { this.#bindings = this.#bindings.filter((x) => document.body.contains(x.obj)); };

        #RGX_CLASS_DIRECTIVE = /^(['"])([a-zA-Z]{1}[0-9a-zA-Z_-]*)\1\s+:\s+(.+)$/;

        // Finds data-class directives and parses class:expression mappings.
        register = () => {
            this.#pruneDetached();

            binder.#queryDirectives("[data-class]")
                ((obj) => {
                    JSBinder.#split(JSBinder.#consumeDataset(obj)("class")).forEach((mapping) => {
                        const m = mapping.match(this.#RGX_CLASS_DIRECTIVE);

                        if (!m)
                            return JSBinder.#error(`Incorrect 'class' syntax: ${mapping}`);

                        const { 2: key, 3: expression } = m;
                        this.#bindings.push({
                            obj, 
                            key, 
                            expressionTree: new JSBinder.#Solver.ExpressionTree(binder, expression), 
                            modified: new JSBinder.#ChangeDetector(),
                        });
                    });
                });
        };

        // Evaluates expressions and toggles CSS classes based on boolean results.
        refresh = () => {
            this.#bindings.forEach((binding) => {
                const result = binding.expressionTree.evaluate();
                if (binding.modified.check(result)) {
                    binding.obj.classList.toggle(binding.key, result);
                    JSBinder.#dispatchEvent(binding.obj, "class", { key: binding.key, action: result ? "add" : "remove" });
                }
            });
        };
    })(this);

    // Style
    //
    // data-style="'backgroundColor' : data.background"
    // data-style="'left' : data.x; 'top" : data.y"
    //
    // event: jsbinder-style with e.detail.key = css property.
    #styleDirective = ((binder) => new class {
        #bindings = [];
        #pruneDetached = () => { this.#bindings = this.#bindings.filter((x) => document.body.contains(x.obj)); };

        #toKebabCase = (text) => text.trim().replace(/([a-z])([A-Z])/g, (_, a, b) => `${a}-${b.toLowerCase()}`); // "marginTop" >> "margin-top"

        #RGX_STYLE_DIRECTIVE = /^(['"])((?:--)?[a-zA-Z]{1}[0-9a-zA-Z_-]*)\1\s+:\s+(.+)$/;

        // Scans for data-style directives, parsing CSS property:expression mappings.
        register = () => {
            this.#pruneDetached();

            binder.#queryDirectives("[data-style]")
                ((obj) => {
                    JSBinder.#split(JSBinder.#consumeDataset(obj)("style")).forEach((mapping) => {
                        const m = mapping.match(this.#RGX_STYLE_DIRECTIVE);

                        if (!m)
                            return JSBinder.#error(`Incorrect 'style' syntax: ${mapping}`);

                        const { 2: key, 3: expression } = m;
                        this.#bindings.push({
                            obj, 
                            key: this.#toKebabCase(key),
                            expressionTree: new JSBinder.#Solver.ExpressionTree(binder, expression), 
                            modified: new JSBinder.#ChangeDetector(),
                        });
                    });
                });
        };

        // Evaluates expressions and applies/removes inline styles based on results.
        refresh = () => {
            this.#bindings.forEach((binding) => {
                const result = binding.expressionTree.evaluate();
                if (binding.modified.check(result)) {
                    if (JSBinder.#isNullish(result)) { binding.obj.style.removeProperty(binding.key); } else { binding.obj.style.setProperty(binding.key, result); };
                    JSBinder.#dispatchEvent(binding.obj, "style", { key: binding.key, value: result });
                }
            });
        };
    })(this);

    #addEvent = (obj) => (type, listener) => obj.addEventListener(type, listener, { 'signal': this.#abortController.signal });

    // OnClick
    //
    // <button data-onclick="page = 0">First page</button>
    // data-onclick="path1 = expression1; path2 = expression2"
    #onClickDirective = ((binder) => new class {

        #RGX_ONCLICK_DIRECTIVE = /^([a-zA-Z]{1}[0-9a-zA-Z_]*(?:(?:\[.+\]|\.)(?:[a-zA-Z]{1}[0-9a-zA-Z_]*)?)*)\s+=\s+(.+)$/;

        // Attaches click event listeners that mutate state based on target:expression mappings.
        register = () => {
            binder.#queryDirectives("[data-onclick]")
                ((obj) => {
                    JSBinder.#split(JSBinder.#consumeDataset(obj)("onclick")).forEach((mapping) => {
                        const m = mapping.match(this.#RGX_ONCLICK_DIRECTIVE);

                        if (!m)
                            return JSBinder.#error(`Incorrect 'onclick' syntax: ${mapping}`);

                        const { 1: target, 2: expression} = m;

                        const applyChange = () => {
                            const evaluated = binder.#evaluate(expression);
                            binder.#mutateState(target, evaluated);
                        };

                        binder.#addEvent(obj)("click", (e) => applyChange());
                    });
                });
        };
    })(this);

    // OnChange
    // 
    // <input type="text" data-onchange="name = @value" data-bind="name" />
    // data-onchange="path1 = expression1; path2 = expression2"
    #onChangeDirective = ((binder) => new class {

        #toSafeString = (input) => JSON.stringify(input); //"'" + input.replace(/\'/g, `' + "'" + '`) + "'";

        #RGX_ONCHANGE_DIRECTIVE = /^([a-zA-Z]{1}[0-9a-zA-Z_]*(?:(?:\[.+\]|\.)(?:[a-zA-Z]{1}[0-9a-zA-Z_]*)?)*)\s+=\s+(.+)$/;
        #RGX_VARIABLE_VALUE = JSBinder.#rgxFormatVariable("value");

        // Attaches input/change event listeners that mutate state using form values in expressions.
        register = () => {
            binder.#queryDirectives("[data-onchange]")
                ((obj) => {
                    JSBinder.#split(JSBinder.#consumeDataset(obj)("onchange")).forEach((mapping) => {
                        const m = mapping.match(this.#RGX_ONCHANGE_DIRECTIVE);

                        if (!m)
                            return JSBinder.#error(`Incorrect 'onchange' syntax: ${mapping}`);

                        const { 1: target, 2: expression} = m;

                        const applyChange = (value) => {
                            const evaluated = binder.#evaluate(expression.replace(this.#RGX_VARIABLE_VALUE, value));
                            binder.#mutateState(target, evaluated);
                        };

                        switch (JSBinder.#typeOf(obj))
                        {
                            case JSBinder.#TYPE.CHECKBOX:
                                binder.#addEvent(obj)("change", (e) => applyChange(!!obj.checked));
                                break;

                            case JSBinder.#TYPE.SELECT:
                                binder.#addEvent(obj)("change", (e) => applyChange(this.#toSafeString(obj.value)));
                                break;

                            case JSBinder.#TYPE.INPUT:
                                binder.#addEvent(obj)("input", (e) => applyChange(this.#toSafeString(obj.value)));
                                break;

                            case JSBinder.#TYPE.TEXTAREA:
                                binder.#addEvent(obj)("input", (e) => applyChange(this.#toSafeString(obj.value)));
                                break;

                            default:
                                return JSBinder.#error(`'onchange' directive is currently only supported for <select> and <input>`);
                        }
                    });
                });
        };
    })(this);

    // Templates
    //
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
    #templateDirective = ((binder) => new class {
        #templates = {};
        
        #RGX_TEMPLATE_DIRECTIVE = /^[a-zA-Z]{1}[0-9a-zA-Z_]*$/;
        #RGX_VARIABLE_DATA = JSBinder.#rgxFormatVariable("data");

        // Find all <template data-template='templatekey' /> to be used from elements with data-render='templatekey'.
        register = () => {
            binder.#queryDirectives("template[data-template]")
                ((obj) => {
                    const key = JSBinder.#consumeDataset(obj)("template");
                    const html = JSBinder.#cleanHTML(obj.innerHTML);
                    
                    if (!key.match(this.#RGX_TEMPLATE_DIRECTIVE))
                        return JSBinder.#error(`'template' parameter 'key' must be a correct variable name`);
                    
                    obj.remove();

                    if (this.#templates[key] !== undefined)
                        JSBinder.#info(`A template with key '${key}' already exists and will be replaced.`);

                    this.#templates = { ...this.#templates, [key]: html };
                });
        };
        
        // Find elements with data-render='templatekey' and data-source='...' and replaces with html from <template data-template='templatekey'>...</template>
        // Template html variable '@data' will be replaced with source from 'data-source'.
        refresh = () => {
            let counter = 0;

            binder.#queryDirectives("[data-render]")
                ((obj) => {
                    const [key, source] = JSBinder.#consumeDataset(obj)("render", "source");
                    const template = this.#templates[key];

                    if (!template)
                        return JSBinder.#error(`No template with key '${key}' found`);

                    if (!source)
                        return JSBinder.#error(`'render' must have 'source' defined`);

                    obj.innerHTML = template.replace(this.#RGX_VARIABLE_DATA, source);
                    JSBinder.#dispatchEvent(obj, "render");
                    counter++;
                });
            
            return counter;
        };
    })(this);

    #stateUpdated = false;
    #needsRegister = false;
    #needsRefresh = false;

    #microtaskQueued = false;

    #queueTasks = () => {
        if (this.#microtaskQueued) return;

        this.#microtaskQueued = true;

        window.queueMicrotask(() => {
            this.#microtaskQueued = false;
             
            if (this.#stateUpdated)  { this.#stateUpdated = false; JSBinder.#dispatchEvent(this.#settings.root, "stateupdated", {}); }
            if (this.#needsRegister) { this.#needsRegister = false; this.#register(); }
            if (this.#needsRefresh)  { this.#needsRefresh = false; this.#refresh(); }
        });
     };

    #register = () => {
        [this.#templateDirective, this.#ifDirective, this.#eachDirective, this.#forDirective, this.#interpolationDirective, this.#bindDirective, this.#attributeDirective, this.#classDirective, this.#styleDirective, this.#onClickDirective, this.#onChangeDirective].forEach(x => x.register());
        this.#refresh();
    };

    #refresh = () => {
        let count = 0;
        [this.#ifDirective, this.#eachDirective, this.#forDirective, this.#interpolationDirective, this.#bindDirective, this.#attributeDirective, this.#classDirective, this.#styleDirective].forEach(x => count += x.refresh() ?? 0);
        if (count === 0) count += this.#templateDirective.refresh();
        if (count > 0) this.#register();
    };


    //ToDo: Add observder to automatically run dispose when root element is removed from dom?
    #dispose = () => {
        this.#abortController.abort();
        this.#settings.root.removeAttribute("data-jsbinder");
        JSBinder.#info("Instance disposed!");
    };

    /**
     * Manually triggers a scan for new DOM elements with data binding attributes.
     * This is useful when you dynamically add new elements to the DOM outside of JSBinder's control.
     * The scan is batched and executed in a microtask for performance.
     * 
     * @returns {void}
     * 
     * @example
     * // Add new elements to DOM
     * document.getElementById('container').innerHTML += '<div data-bind="newData"></div>';
     * 
     * // Tell JSBinder to scan for new bindings
     * binder.scan();
     * 
     * @example
     * // After AJAX content load
     * fetch('/api/template')
     *   .then(response => response.text())
     *   .then(html => {
     *     document.getElementById('dynamic-content').innerHTML = html;
     *     binder.scan(); // Register new bindings in the loaded HTML
     *   });
     */
    scan = () => { this.#needsRegister = true; this.#queueTasks(); };

    /**
     * Disposes the JSBinder instance, removing all event listeners and cleaning up resources.
     * After calling dispose(), the instance cannot be reused and should be set to null.
     * The data-jsbinder attribute is removed from the root element, allowing a new instance to be created.
     * 
     * @returns {void}
     * 
     * @example
     * // Clean up when done
     * let binder = new JSBinder({ root: document.getElementById('app') });
     * // ... use binder ...
     * binder.dispose();
     * binder = null; // Remove reference for garbage collection
     * 
     * @example
     * // Single-page app route change
     * function navigateTo(route) {
     *   if (currentBinder) {
     *     currentBinder.dispose();
     *     currentBinder = null;
     *   }
     *   // Load new route
     *   currentBinder = new JSBinder({ root: loadRoute(route) });
     * }
     */
    dispose = () => { this.#dispose(); };
};