import { ComponentFixture, TestBed } from '@angular/core/testing';

import { Root } from './root';

describe('Root', (): void => {
  let component: Root;
  let fixture: ComponentFixture<Root>;

  beforeEach(async (): Promise<void> => {
    await TestBed.configureTestingModule({
      imports: [Root]
    })
    .compileComponents();

    fixture = TestBed.createComponent(Root);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('should create', (): void => {
    expect(component).toBeTruthy();
  });
});
