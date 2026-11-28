// The components the page adds to OpenUI's chat library, and the ones it changes.
// scripts/openui-library.ts writes the same list for the inbox, so the inbox refuses a body the page cannot draw.
// This module reads no browser globals, so Node can load it.

/** `base` extended with the page's components. `draw` holds how the page draws each one; without it, they draw nothing. */
export function extendLibrary(base, draw = {}) {
  const { FormControl, AccordionItem, CodeBlock, Input, OptionCards, IconButton, Table } = base.components;
  const nothing = () => null;
  const mermaidProps = FormControl.props.pick({}).extend({ source: CodeBlock.props.shape.codeString });
  const secretInputProps = Input.props.pick({ name: true }).extend({ publicKey: Input.props.shape.name });
  const secretAccessProps = secretInputProps.extend({ candidates: Input.props.shape.name });
  const privilegedActionProps = Input.props.pick({ name: true }).extend({ command: Input.props.shape.name, machine: Input.props.shape.name, changes: Input.props.shape.name });
  const oneTimeCodeProps = Input.props.pick({ name: true }).extend({ key: Input.props.shape.name, purpose: Input.props.shape.name, publicKey: Input.props.shape.name });
  const checkWithTextProps =FormControl.props.pick({ label: true }).extend({ check: FormControl.props.shape.input, content: AccordionItem.props.shape.content });
  return base.extend({ components: {
    add: [{
      component: { name: 'CheckWithText', props: checkWithTextProps, ref: checkWithTextProps, description: 'A check box with a label that shows editable content when clicked.', component: draw.CheckWithText ?? nothing },
      slots: ['Card.children', 'FormControl.input'],
    }, {
      component: { name: 'Mermaid', props: mermaidProps, ref: mermaidProps, description: 'A diagram drawn from Mermaid source.', component: draw.Mermaid ?? nothing },
      // Wherever a CodeBlock can go.
      slots: ['Card.children', 'SectionItem.content', 'TabItem.content', 'AccordionItem.content', 'Carousel.children'],
    }, {
      component: { name: 'SecretInput', props: secretInputProps, ref: secretInputProps, description: 'A secret field: the page seals the value with the public key, a JSON Web Key as text.', component: draw.SecretInput ?? nothing },
      slots: ['FormControl.input'],
    }, {
      component: { name: 'SecretAccess', props: secretAccessProps, ref: secretAccessProps, description: 'Asks for access to a secret: the person grants one candidate, declines, or types a value the page seals with the public key. The candidates are a JSON list as text.', component: draw.SecretAccess ?? nothing },
      slots: ['FormControl.input'],
    }, {
      component: { name: 'PrivilegedAction', props: privilegedActionProps, ref: privilegedActionProps, description: 'A command that needs the person\'s password: the page shows the command, the machine and what it changes, and seals the password to the inbox\'s broker.', component: draw.PrivilegedAction ?? nothing },
      slots: ['FormControl.input'],
    }, {
      component: { name: 'OneTimeCode', props: oneTimeCodeProps, ref: oneTimeCodeProps, description: 'Asks the person to approve a one-time code from an enrolled key, for the purpose it states. The page shows the key, the purpose and which inbox holds the key, never a code.', component: draw.OneTimeCode ?? nothing },
      slots: ['FormControl.input'],
    }],
    override: [
      { ...FormControl, component: draw.FormControl ?? FormControl.component },
      { ...OptionCards, component: draw.OptionCards ?? OptionCards.component },
      // The page shows an icon button's name as a tooltip too; the inbox needs only the same props.
      { ...IconButton, component: draw.IconButton ?? IconButton.component },
      // The page draws each text cell as inline Markdown; the inbox needs only the same props.
      { ...Table, component: draw.Table ?? Table.component },
    ],
  } });
}
