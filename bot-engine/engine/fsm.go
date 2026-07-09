package botengine

// FSMState represents a state in the Finite State Machine.
type FSMState string

// FSM is a simple Finite State Machine that behaviors can use to manage their internal states.
type FSM struct {
	CurrentState FSMState
}

func NewFSM(initial FSMState) *FSM {
	return &FSM{
		CurrentState: initial,
	}
}

func (f *FSM) Transition(next FSMState) {
	f.CurrentState = next
}
