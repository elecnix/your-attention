// The components the page adds to OpenUI's chat library, and the one it changes.
// scripts/openui-library.ts writes the same list for the inbox, so the inbox refuses a body the page cannot draw.
// This module reads no browser globals, so Node can load it.

/** `base` extended with the page's components. `draw` holds how the page draws each one; without it, they draw nothing. */
export function extendLibrary(base, draw = {}) {
  const { FormControl, AccordionItem, CodeBlock } = base.components;
  const nothing = () => null;
  const mermaidProps = FormControl.props.pick({}).extend({ source: CodeBlock.props.shape.codeString });
  const checkWithTextProps = FormControl.props.pick({ label: true }).extend({ check: FormControl.props.shape.input, content: AccordionItem.props.shape.content });
  return base.extend({ components: {
    add: [{
      component: { name: 'CheckWithText', props: checkWithTextProps, ref: checkWithTextProps, description: 'A check box with a label that shows editable content when clicked.', component: draw.CheckWithText ?? nothing },
      slots: ['Card.children', 'FormControl.input'],
    }, {
      component: { name: 'Mermaid', props: mermaidProps, ref: mermaidProps, description: 'A diagram drawn from Mermaid source.', component: draw.Mermaid ?? nothing },
      // Wherever a CodeBlock can go.
      slots: ['Card.children', 'SectionItem.content', 'TabItem.content', 'AccordionItem.content', 'Carousel.children'],
    }],
    override: [{ ...FormControl, component: draw.FormControl ?? FormControl.component }],
  } });
}
